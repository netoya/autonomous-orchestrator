// Dispatcher esqueleto — MVP Tier 1.
// Implementa tick A (selector de tasks ready) y tick E (consumer de eventos task.finished).
// Recovery minimo, kill-switch, heartbeat, graceful shutdown.

import { writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { openDb } from './db/connection.js';
import { makeAgentRunner } from './agent/index.js';
import { ulid } from './lib/ulid.js';
import { now as clockNow } from './lib/clock.js';
import { getCoordinatorSystemPrompt, CLI_TOOLS_PATH } from './coordinator/system-prompt.js';
import {
  findTaskById,
  updateTaskStatus,
  markTaskAsDone,
  type TaskRow,
} from './db/dao/tasks.js';
import {
  listPassiveWaitersForTask,
  listPendingActiveWaiters,
  fulfillWaiter,
} from './db/dao/waiters.js';
import { executeCommand } from './dispatcher/exec-runner.js';
import {
  findFlowById,
  updateFlowStatus,
} from './db/dao/flows.js';
import {
  createExecution,
  finishExecution,
} from './db/dao/executions.js';
import {
  listPendingEvents,
  markConsumed,
  insertEvent,
  type EventRow,
} from './db/dao/events.js';
import {
  lookupSession,
  upsertSession,
} from './db/dao/agent-sessions.js';
import type Database from 'better-sqlite3';
import type { AgentRunner } from './agent/types.js';

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS ?? '3', 10);
const TICK_A_INTERVAL_MS = 500; // selector de tasks ready
const TICK_E_INTERVAL_MS = 250; // consumer de eventos
const TICK_F_INTERVAL_MS = 2000; // ejecutor de exec-command waiters (2s)
const TICK_G_INTERVAL_MS = 30000; // re-invocacion coordinator para tasks failed (30s)
const TICK_H_INTERVAL_MS = 60000; // cleanup waiters huerfanos (60s)
const KILL_TIMEOUT_MS = parseInt(process.env.KILL_TIMEOUT_MS ?? '30000', 10);
const STATE_DIR = process.env.STATE_DIR ?? 'state';

// Session strategy configuration
const SESSION_STRATEGY = process.env.SESSION_STRATEGY ?? 'flow-agent-task';
const MAX_TURNS_PER_SESSION = parseInt(process.env.MAX_TURNS_PER_SESSION ?? '50', 10);

interface WorkerSlot {
  taskId: string;
  promise: Promise<void>;
}

export class Dispatcher {
  private db: Database.Database;
  private agentRunner: AgentRunner;
  private workers: WorkerSlot[] = [];
  private activeWorkerIds = new Set<string>();
  private running = false;
  private tickATimer: NodeJS.Timeout | null = null;
  private tickETimer: NodeJS.Timeout | null = null;
  private tickFTimer: NodeJS.Timeout | null = null;
  private tickGTimer: NodeJS.Timeout | null = null;
  private tickHTimer: NodeJS.Timeout | null = null;
  private execWaitersInFlight = new Set<string>(); // anti-doble-ejecucion
  private childPids = new Set<number>(); // FIX #3: trackear child processes

  constructor(dbPath?: string) {
    this.db = openDb(dbPath);
    this.agentRunner = makeAgentRunner();

    // Exportar ORCHESTRATOR_DB para que cualquier subproceso (ej: claude headless
    // ejecutando npx tsx cli-tools.ts createFlow desde otro cwd) resuelva la misma DB.
    // Sin esto, openDb() en el subproceso caeria a process.cwd()/state/orchestrator.db
    // que apuntaria a una DB inexistente cuando el cwd del agente es otro repo.
    if (!process.env.ORCHESTRATOR_DB) {
      const resolvedDbPath = dbPath
        ? resolvePath(dbPath)
        : resolvePath(process.cwd(), 'state/orchestrator.db');
      process.env.ORCHESTRATOR_DB = resolvedDbPath;
      console.log(`[dispatcher] Exporting ORCHESTRATOR_DB=${resolvedDbPath} to children`);
    }
  }

  async start(): Promise<void> {
    console.log(`[dispatcher] Starting with MAX_WORKERS=${MAX_WORKERS}`);

    // Startup validation: SESSION_STRATEGY
    if (!['flow-agent-task', 'none'].includes(SESSION_STRATEGY)) {
      console.error(
        `[dispatcher] FATAL: Invalid SESSION_STRATEGY="${SESSION_STRATEGY}". Valid values: flow-agent-task, none`
      );
      process.exit(1);
    }

    // Startup validation: MAX_TURNS_PER_SESSION
    if (isNaN(MAX_TURNS_PER_SESSION) || MAX_TURNS_PER_SESSION <= 0) {
      console.error(
        `[dispatcher] FATAL: Invalid MAX_TURNS_PER_SESSION="${process.env.MAX_TURNS_PER_SESSION}". Must be a positive integer.`
      );
      process.exit(1);
    }

    console.log(
      `[dispatcher] Session strategy: ${SESSION_STRATEGY}, max_turns: ${MAX_TURNS_PER_SESSION}`
    );

    // Recovery: buscar waiters activos huerfanos (spec 3.6.4)
    // En MVP esqueleto solo loguea; no re-spawnea porque el scheduler de waiters activos no esta.
    const orphanedWaiters = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM waiters
         WHERE mode = 'active' AND status = 'waiting'
           AND (last_checked IS NULL OR last_checked < ?)`,
      )
      .get(clockNow() - 3600_000) as { count: number };

    if (orphanedWaiters.count > 0) {
      console.log(
        `[dispatcher] Recovery: found ${orphanedWaiters.count} orphaned active waiters (not re-spawning in MVP skeleton)`,
      );
    }

    // Recovery: waiters pasivos huerfanos (mode=passive, status=waiting con task en ready)
    // Si el dispatcher crasheo justo despues de que un fulfill llegara y la task transiciono a ready,
    // debe re-evaluar que esa task realmente no tenga waiters pendientes.
    const tasksWithPassiveWaiters = this.db
      .prepare(
        `SELECT t.id
         FROM tasks t
         WHERE t.status = 'ready'
           AND EXISTS (
             SELECT 1 FROM waiters w
             WHERE w.task_id = t.id
               AND w.status = 'waiting'
               AND w.mode = 'passive'
           )`,
      )
      .all() as Array<{ id: string }>;

    if (tasksWithPassiveWaiters.length > 0) {
      console.log(
        `[dispatcher] Recovery: found ${tasksWithPassiveWaiters.length} tasks in 'ready' state with passive waiters pending. Transitioning to 'waiting-waiter'`,
      );
      const timestamp = clockNow();
      for (const { id } of tasksWithPassiveWaiters) {
        updateTaskStatus(this.db, id, 'waiting-waiter', timestamp);
        console.log(`[dispatcher] Recovery: task ${id} -> waiting-waiter (passive waiters pending)`);
      }
    }

    // Recovery: tasks huerfanas en 'running' (el dispatcher anterior murio sin marcarlas).
    // Cualquier task en 'running' al arranque es necesariamente huerfana porque single-dispatcher:
    // si este proceso esta arrancando, no hay otro worker procesandolas. Resetear a 'ready' para
    // que tick A las retome. Incrementa retries para que tick G las pueda escalar si fallan repetidamente.
    const orphanedRunning = this.db
      .prepare(`SELECT id, stage, retries FROM tasks WHERE status = 'running'`)
      .all() as Array<{ id: string; stage: string; retries: number }>;

    if (orphanedRunning.length > 0) {
      console.log(
        `[dispatcher] Recovery: found ${orphanedRunning.length} orphaned tasks in 'running'. Resetting to 'ready'.`,
      );
      const timestamp = clockNow();
      const stmt = this.db.prepare(
        `UPDATE tasks SET status = 'ready', retries = retries + 1, updated_at = ? WHERE id = ?`,
      );
      for (const { id, stage, retries } of orphanedRunning) {
        stmt.run(timestamp, id);
        console.log(
          `[dispatcher] Recovery: task ${id} (stage=${stage}) running -> ready, retries=${retries + 1}`,
        );
      }
    }

    this.running = true;

    // Notificar a PM2 si esta corriendo bajo supervisor
    process.send?.('ready');

    // Iniciar ticks
    this.tickATimer = setInterval(() => this.tickA(), TICK_A_INTERVAL_MS);
    this.tickETimer = setInterval(() => this.tickE(), TICK_E_INTERVAL_MS);
    this.tickFTimer = setInterval(() => this.tickF(), TICK_F_INTERVAL_MS);
    this.tickGTimer = setInterval(() => this.tickG(), TICK_G_INTERVAL_MS);
    this.tickHTimer = setInterval(() => this.tickH(), TICK_H_INTERVAL_MS);

    console.log('[dispatcher] Started');
  }

  async stop(): Promise<void> {
    console.log('[dispatcher] Stopping (graceful shutdown)...');
    this.running = false;

    // Detener ticks
    if (this.tickFTimer) clearInterval(this.tickFTimer);
    if (this.tickATimer) clearInterval(this.tickATimer);
    if (this.tickETimer) clearInterval(this.tickETimer);
    if (this.tickGTimer) clearInterval(this.tickGTimer);
    if (this.tickHTimer) clearInterval(this.tickHTimer);

    // Esperar a que terminen los workers actuales con timeout
    const deadline = Date.now() + KILL_TIMEOUT_MS;
    while (this.workers.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.workers.length > 0) {
      console.warn(
        `[dispatcher] Timeout: ${this.workers.length} workers still running, forcing exit`,
      );
    }

    // FIX #3: Cleanup de child processes huerfanos
    if (this.childPids.size > 0) {
      console.log(`[dispatcher] Cleaning up ${this.childPids.size} child processes...`);
      for (const pid of this.childPids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (err) {
          // Proceso ya termino o no existe — ignorar
        }
      }

      // Esperar 2s para que terminen gracefully
      await new Promise((r) => setTimeout(r, 2000));

      // SIGKILL a los que sobrevivieron
      for (const pid of this.childPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Ignorar — ya murio
        }
      }

      this.childPids.clear();
    }

    this.db.close();
    console.log('[dispatcher] Stopped');
  }

  // Tick A: selector de tasks ready (cada 500 ms)
  private tickA(): void {
    try {
      // Kill-switch check
      if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
        console.log('[dispatcher] Kill-switch detected, draining workers...');
        this.running = false;
        return;
      }

      // Heartbeat
      writeFileSync(`${STATE_DIR}/.heartbeat`, String(clockNow()));

      // Si no hay slots libres, saltar
      const freeSlots = MAX_WORKERS - this.activeWorkerIds.size;
      if (freeSlots <= 0) return;

      // FIX: promover tasks queued -> ready cuando todas sus deps estan done.
      // Sin este step, una task downstream cuya dep fue repuntada despues de crear la task
      // (ej: -retry-N que tomo el rol del original failed) queda trabada en queued para siempre.
      // createCoordinatorTask hace esta promocion solo en el momento de crear la task; este
      // tick mantiene la invariante en el tiempo.
      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'ready', updated_at = ?
           WHERE status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_task_id
               WHERE td.task_id = tasks.id AND dep.status <> 'done'
             )`,
        )
        .run(clockNow());

      // Selector: buscar tasks ready con mayor prioridad (work stealing minimo)
      // TODO(roman): implementar WSJF completo cuando haya business_value + estimated_minutes
      const readyTasks = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status = 'ready'
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(freeSlots) as TaskRow[];

      for (const task of readyTasks) {
        // FIX race window: NO agregar aqui, se agrega dentro de runTask despues del gate check

        const promise = this.runTask(task.id).catch((err) => {
          console.error(`[dispatcher] Uncaught error running task ${task.id}:`, err);
        });

        this.workers.push({ taskId: task.id, promise });

        // Limpiar cuando termine
        promise.finally(() => {
          this.activeWorkerIds.delete(task.id);
          this.workers = this.workers.filter((w) => w.taskId !== task.id);
        });
      }
    } catch (err) {
      console.error('[dispatcher] Tick A fatal error (caught, dispatcher survives):', err);
    }
  }

  // Tick E: consumer de eventos task.finished (cada 250 ms)
  private tickE(): void {
    try {
      if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
        return;
      }

      const pending = listPendingEvents(this.db, 50);

      for (const event of pending) {
        if (event.kind === 'task.finished') {
          this.handleTaskFinished(event);
        } else if (event.kind === 'waiter.fulfilled') {
          this.handleWaiterFulfilled(event);
        }

        // Marcar como consumido y appendear a events.jsonl
        markConsumed(this.db, event.id);
        this.appendToEventLog(event);
      }
    } catch (err) {
      console.error('[dispatcher] Tick E fatal error (caught, dispatcher survives):', err);
    }
  }

  // Tick F: ejecutor de waiters activos kind='exec-command' (cada 2s).
  // Permite a sub-claudes encolar comandos (npm run dev, playwright test, curl) sin morir
  // por SIGTERM del wrapper anti-comandos. El dispatcher ejecuta desde su propio proceso
  // y deja stdout/exitCode en value_json para que el agente lo lea via --resume.
  private tickF(): void {
    try {
      if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
        return;
      }
      const pending = listPendingActiveWaiters(this.db, 'exec-command');
      const now = clockNow();
      for (const waiter of pending) {
        if (this.execWaitersInFlight.has(waiter.id)) continue;

        // Validar que no expiro
        if (waiter.expires_at && waiter.expires_at < now) {
          this.db
            .prepare(`UPDATE waiters SET status='timeout' WHERE id=?`)
            .run(waiter.id);
          console.log(`[dispatcher] tickF: waiter ${waiter.id} expirado, marcado timeout`);
          continue;
        }

        let params: { cmd: string; cwd?: string; timeoutMs?: number };
        try {
          params = JSON.parse(waiter.condition_params_json ?? '{}');
          if (!params.cmd || typeof params.cmd !== 'string') {
            throw new Error('cmd faltante o no string');
          }
        } catch (err) {
          this.db
            .prepare(`UPDATE waiters SET status='invalid', value_json=? WHERE id=?`)
            .run(JSON.stringify({ error: `invalid params: ${String(err)}` }), waiter.id);
          console.warn(`[dispatcher] tickF: waiter ${waiter.id} params invalidos`);
          continue;
        }

        this.execWaitersInFlight.add(waiter.id);
        console.log(
          `[dispatcher] tickF: ejecutando exec-command waiter=${waiter.id} cmd="${params.cmd.slice(0, 80)}" cwd=${params.cwd ?? '(default)'}`,
        );

        // Ejecutar en background; no bloquear el tick
        executeCommand(params)
          .then((result) => {
            const value = {
              cmd: params.cmd,
              cwd: params.cwd ?? null,
              ok: result.ok,
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              duration_ms: result.durationMs,
              ...(result.rejected ? { rejected: result.rejected } : {}),
            };
            fulfillWaiter(
              this.db,
              waiter.id,
              JSON.stringify(value),
              'dispatcher-exec',
              clockNow(),
            );
            console.log(
              `[dispatcher] tickF: waiter ${waiter.id} fulfilled exit=${result.exitCode} dur=${result.durationMs}ms`,
            );
          })
          .catch((err) => {
            console.error(`[dispatcher] tickF: error ejecutando waiter ${waiter.id}:`, err);
            try {
              this.db
                .prepare(`UPDATE waiters SET status='invalid', value_json=? WHERE id=?`)
                .run(JSON.stringify({ error: String(err) }), waiter.id);
            } catch {
              /* ignore */
            }
          })
          .finally(() => {
            this.execWaitersInFlight.delete(waiter.id);
          });
      }
    } catch (err) {
      console.error('[dispatcher] Tick F fatal error (caught, dispatcher survives):', err);
    }
  }

  // Tick G: re-invocacion automatica del coordinator para tasks failed (cada 30s)
  private tickG(): void {
    try {
      if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
        return;
      }

      // Buscar tasks failed que NO tienen ya un coordinator-recovery atendiendolas.
      // FIX: ignorar tasks cuyo flow esta cancelled/failed/completed — esos flows ya estan cerrados
      // y NO deben generar mas recovery (bug observado: visor-ws-stream cancelled generaba
      // waiters recovery-recursion-block en loop infinito).
      const failedTasks = this.db
        .prepare(
          `SELECT t.id, t.flow_id, t.stage, t.agent_id, t.retries, t.error
           FROM tasks t
           JOIN flows f ON f.id = t.flow_id
           WHERE t.status = 'failed'
             AND f.status NOT IN ('cancelled','failed','completed')
             AND NOT EXISTS (
               SELECT 1 FROM tasks coord
               WHERE coord.flow_id = t.flow_id
                 AND coord.parent_task_id = t.id
                 AND coord.agent_id = 'softwarefactory_coordinator'
                 AND coord.status IN ('queued','ready','running','done')
             )`,
        )
        .all() as Array<{
          id: string;
          flow_id: string;
          stage: string;
          agent_id: string;
          retries: number;
          error: string | null;
        }>;

      if (failedTasks.length === 0) return;

      console.log(
        `[dispatcher] Tick G: found ${failedTasks.length} failed tasks needing coordinator recovery`,
      );

      const timestamp = clockNow();

      for (const failedTask of failedTasks) {
        // FIX #2 (P0): Limite de profundidad para recovery recursivo.
        // Si la task fallida ya es ella misma un coordinator-recovery, NO crear otro recovery.
        // En su lugar, crear un waiter pasivo para decision humana.
        if (failedTask.stage.startsWith('coordinate-recovery-')) {
          // FIX: chequear que no exista ya un waiter recovery-recursion-block para esta task.
          // Sin este check, cada Tick G inserta un nuevo waiter con ULID nuevo (no hay UNIQUE
          // en task_id+step_id), causando regeneracion infinita (bug observado: 2546 waiters
          // generados para visor-ws-stream).
          const existingWaiter = this.db
            .prepare(
              `SELECT id FROM waiters
               WHERE task_id = ? AND step_id = 'recovery-recursion-block'
                 AND status IN ('waiting','fulfilled','rejected')
               LIMIT 1`,
            )
            .get(failedTask.id) as { id: string } | undefined;

          if (existingWaiter) {
            // Ya existe waiter para esta task — skip silenciosamente (evita log spam)
            continue;
          }

          console.log(
            `[dispatcher] Tick G: failed task ${failedTask.id} is already a coordinator-recovery (${failedTask.stage}), creating passive waiter instead of recursion`,
          );

          try {
            const waiterId = ulid();
            const waiterStmt = this.db.prepare(`
              INSERT INTO waiters (
                id, flow_id, task_id, step_id, mode, kind, prompt, schema_json,
                timeout_ms, created_at, expires_at, status
              )
              VALUES (?, ?, ?, ?, 'passive', 'approve-text', ?, ?, ?, ?, ?, 'waiting')
            `);

            const prompt = `Tick G detecto recursion en recovery (${failedTask.stage} fallo).

Task fallida: ${failedTask.stage}
Error: ${failedTask.error ?? 'desconocido'}
Flow: ${failedTask.flow_id}

El orquestador NO va a crear otra capa de recovery automaticamente.

Decida:
- "abort": cancelar el flow completo (error no recuperable)
- "manual": usted resuelve el bug subyacente en codigo del orquestador o agente, despues hace UPDATE manual en la DB
- "skip": marcar el flow como completed-with-failures (tolerancia a error parcial)`;

            const schemaJson = JSON.stringify({
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['abort', 'manual', 'skip'] },
                reason: { type: 'string' },
              },
              required: ['action', 'reason'],
            });

            waiterStmt.run(
              waiterId,
              failedTask.flow_id,
              failedTask.id,
              'recovery-recursion-block',
              prompt,
              schemaJson,
              86400000, // 24h timeout
              timestamp,
              timestamp + 86400000,
            );

            console.log(
              `[dispatcher] Tick G: created passive waiter ${waiterId} for recursion-blocked recovery task ${failedTask.id}`,
            );
          } catch (err: any) {
            if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
              // Ya existe un waiter para esta task — skip
              console.log(
                `[dispatcher] Tick G: waiter already exists for recursion-blocked task ${failedTask.id}, skipping`,
              );
              continue;
            }
            throw err;
          }

          continue; // NO crear coordinator-recovery
        }

        try {
          // Crear task coordinator con stage coordinate-recovery-{slug}
          const coordinatorStage = `coordinate-recovery-${failedTask.stage}`;
          const coordinatorTaskId = ulid();

          // Preparar el input_json con el mensaje de recovery
          const recoveryMessage = `Una task fallo en este flow. Tu trabajo es decidir como resolverlo.

Task fallida: ${failedTask.stage}
Agente: ${failedTask.agent_id}
Error: ${failedTask.error ?? 'desconocido'}
Retries usados: ${failedTask.retries}

Lee los archivos relevantes del proyecto para entender el contexto. Opciones:
1. Si crees que se puede reintentar con un prompt mejor, crea una task NUEVA con el mismo stage (sera deduplicada por idempotency_key — usa un sufijo como -retry-1 en el stage).
2. Si el problema requiere intervencion humana, crea un waiter pasivo (npx tsx ${CLI_TOOLS_PATH} createWaiter --flow-id ${failedTask.flow_id} --task-slug ${coordinatorStage} --step-id decision-1 --kind approve-text --prompt "Decidir como resolver la task fallida ${failedTask.stage}" --schema-json '{"type":"object","properties":{"action":{"type":"string"},"reason":{"type":"string"}},"required":["action","reason"]}') que pida al operador que decida.
3. Si la task ya hizo trabajo util (revisa archivos en el directorio del proyecto), puedes considerarla parcialmente exitosa y crear sub-tasks que continuen desde ahi.

Flow id: ${failedTask.flow_id}`;

          const inputJson = JSON.stringify({
            message: recoveryMessage,
            permission_mode: 'acceptEdits',
            max_turns: 30,
          });

          // Crear la task coordinator-recovery
          const stmt = this.db.prepare(`
            INSERT INTO tasks (
              id, flow_id, parent_task_id, stage, agent_id, status, input_json, output_json,
              retries, idempotency_key, created_at, updated_at, priority, business_value,
              estimated_minutes, tags_json, is_milestone
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            coordinatorTaskId,
            failedTask.flow_id,
            failedTask.id, // parent_task_id = la task fallida
            coordinatorStage,
            'softwarefactory_coordinator',
            'ready', // Listo para ejecutar inmediatamente
            inputJson,
            null, // output_json
            `${failedTask.flow_id}-${coordinatorStage}`, // idempotency_key
            timestamp,
            timestamp,
            10, // priority max
            null, // business_value
            null, // estimated_minutes
            '[]', // tags_json
            0, // is_milestone
          );

          console.log(
            `[dispatcher] Tick G: created coordinator-recovery task ${coordinatorTaskId} for failed task ${failedTask.id}`,
          );
        } catch (err: any) {
          if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            console.log(
              `[dispatcher] Tick G: skipping ${failedTask.id} — coordinator-recovery already exists (idempotency_key collision)`,
            );
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error('[dispatcher] Tick G fatal error (caught, dispatcher survives):', err);
    }
  }

  // Tick H: cleanup de waiters huerfanos (cada 60s)
  // Un waiter huerfano es uno en estado 'waiting' cuya task asociada ya esta en estado terminal.
  // EXCEPCION: waiters con kind='approve-text' son passive y esperan input HUMANO; su lifetime
  // esta desacoplado de la task que los creo (la task recovery termina su rol al crear el waiter,
  // pero el waiter sigue vivo hasta que el operador responda o expires_at vence).
  private tickH(): void {
    try {
      if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
        return;
      }

      const nowMs = clockNow();

      // 1) Expirar waiters cuya task esta terminal Y el waiter NO es de approval humano.
      const orphanStmt = this.db.prepare(`
        UPDATE waiters
        SET status = 'timeout'
        WHERE status = 'waiting'
          AND kind <> 'approve-text'
          AND task_id IN (
            SELECT id FROM tasks WHERE status IN ('done', 'cancelled', 'failed')
          )
      `);
      const orphanResult = orphanStmt.run();

      if (orphanResult.changes > 0) {
        console.log(
          `[dispatcher] Tick H: expired ${orphanResult.changes} orphan waiters (task in terminal state, non-approval)`,
        );
      }

      // 2) Expirar waiters approve-text que pasaron su expires_at natural (TTL del waiter).
      const ttlStmt = this.db.prepare(`
        UPDATE waiters
        SET status = 'timeout'
        WHERE status = 'waiting'
          AND kind = 'approve-text'
          AND expires_at < ?
      `);
      const ttlResult = ttlStmt.run(nowMs);

      if (ttlResult.changes > 0) {
        console.log(
          `[dispatcher] Tick H: expired ${ttlResult.changes} approve-text waiters (expires_at passed)`,
        );
      }
    } catch (err) {
      console.error('[dispatcher] Tick H fatal error (caught, dispatcher survives):', err);
    }
  }

  private handleWaiterFulfilled(event: EventRow): void {
    const payload = JSON.parse(event.payload_json) as { task_id: string; waiter_id: string };
    const taskId = payload.task_id;

    // FIX: Chequear estado actual de la task antes de transicionar
    const task = findTaskById(this.db, taskId);
    if (!task) {
      console.log(`[dispatcher] Waiter fulfilled for task ${taskId} but task not found, skipping`);
      return;
    }

    // Si la task ya esta en un estado terminal, no hacer nada
    if (['done', 'cancelled', 'failed'].includes(task.status)) {
      console.log(`[dispatcher] Waiter fulfilled for task ${taskId} but task is already ${task.status}, no transition`);
      return;
    }

    // Solo transicionar si esta en waiting-waiter (estado esperado)
    if (task.status !== 'waiting-waiter') {
      console.log(`[dispatcher] Waiter fulfilled for task ${taskId} but task is in ${task.status}, expected waiting-waiter, no transition`);
      return;
    }

    // Verificar que no queden waiters pasivos pendientes
    const pendingWaiters = listPassiveWaitersForTask(this.db, taskId);
    if (pendingWaiters.length > 0) {
      console.log(`[dispatcher] Task ${taskId} still has ${pendingWaiters.length} pending waiters, not transitioning`);
      return;
    }

    // Verificar que todas las deps estan cumplidas (misma query que handleTaskFinished)
    const pendingDeps = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM task_dependencies td
         JOIN tasks t ON t.id = td.depends_on_task_id
         WHERE td.task_id = ?
           AND t.status <> 'done'`,
      )
      .get(taskId) as { count: number };

    if (pendingDeps.count === 0) {
      // Todos los waiters cumplidos y todas las deps satisfechas → transicionar a ready
      updateTaskStatus(this.db, taskId, 'ready', clockNow());
      console.log(`[dispatcher] Task ${taskId} -> ready (waiter fulfilled, all deps satisfied)`);
    } else {
      console.log(`[dispatcher] Task ${taskId} waiter fulfilled but still has ${pendingDeps.count} pending deps`);
    }
  }

  private handleTaskFinished(event: EventRow): void {
    const payload = JSON.parse(event.payload_json) as { task_id: string };
    const taskId = payload.task_id;

    const task = findTaskById(this.db, taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} not found in handleTaskFinished`);
      return;
    }

    // Buscar tasks dependientes de esta
    const dependents = this.db
      .prepare(
        `SELECT t.id, t.status
         FROM tasks t
         JOIN task_dependencies td ON td.task_id = t.id
         WHERE td.depends_on_task_id = ?
           AND t.status IN ('queued', 'waiting-waiter')`,
      )
      .all(taskId) as Array<{ id: string; status: string }>;

    for (const dep of dependents) {
      // Verificar si TODAS las deps del dependiente estan done
      const pendingDeps = this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.depends_on_task_id
           WHERE td.task_id = ?
             AND t.status <> 'done'`,
        )
        .get(dep.id) as { count: number };

      if (pendingDeps.count === 0) {
        // Todas las deps cumplidas → marcar como ready
        updateTaskStatus(this.db, dep.id, 'ready', clockNow());
        console.log(`[dispatcher] Task ${dep.id} → ready (all deps satisfied)`);
      }
    }

    // Verificar si todas las tasks del flow estan done o cancelled
    const incompleteTasks = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE flow_id = ? AND status NOT IN ('done', 'cancelled')`,
      )
      .get(task.flow_id) as { count: number };

    if (incompleteTasks.count === 0) {
      const timestamp = clockNow();
      // FIX: envolver en transaccion atomica para garantizar consistencia
      this.db.transaction(() => {
        updateFlowStatus(this.db, task.flow_id, 'completed', timestamp);
        insertEvent(this.db, 'flow.completed', {
          flow_id: task.flow_id,
          completed_at: timestamp,
        }, timestamp);
      })();
      console.log(`[dispatcher] Flow ${task.flow_id} -> completed`);
    }
  }

  private appendToEventLog(event: EventRow): void {
    // TODO(roman): implementar append a state/events.jsonl con hash
    // Por ahora solo log
    console.log(`[dispatcher] Event consumed: ${event.kind} (id=${event.id})`);
  }

  private validateTaskArtifacts(taskId: string, output: string): void {
    // FIX #2: Detectar falsos positivos en tasks marcados como done
    // pero que en realidad no escribieron archivos o reportaron errores.

    // Patron 1: Buscar indicadores de fallo explicitos
    const failurePatterns = [
      /could not/i,
      /permission denied/i,
      /blocked/i,
      /max_turns_reached/i,
      /unable to/i,
      /no pude/i,
    ];

    for (const pattern of failurePatterns) {
      if (pattern.test(output)) {
        console.warn(
          `[dispatcher] WARN: Task ${taskId} may have not completed: output contains failure indicator "${pattern.source}"`,
        );
        return;
      }
    }

    // Patron 2: Extraer paths mencionados por el agente
    const pathPatterns = [
      /(?:Created|Wrote|File written|Modified|Edited):\s*([/~][^\s]+)/gi,
      /(?:^|\s)([/~][^\s]+\.(?:ts|js|tsx|jsx|json|md|txt|css|html))/gi,
    ];

    const mentionedPaths = new Set<string>();
    for (const pattern of pathPatterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        const path = match[1];
        if (path) mentionedPaths.add(path);
      }
    }

    if (mentionedPaths.size === 0) {
      // No se mencionaron paths — puede ser valido (ej: coordinator, tareas de analisis)
      return;
    }

    // Verificar cuales de los paths mencionados existen en disco
    let existingCount = 0;
    for (const path of mentionedPaths) {
      try {
        if (existsSync(path)) existingCount++;
      } catch {
        // Ignorar errores de permisos o paths invalidos
      }
    }

    console.log(
      `[dispatcher] Task ${taskId} mentioned ${mentionedPaths.size} paths, ${existingCount} exist on disk`,
    );

    if (existingCount === 0 && mentionedPaths.size > 0) {
      console.warn(
        `[dispatcher] WARN: Task ${taskId} mentioned ${mentionedPaths.size} paths but NONE exist on disk (possible false positive)`,
      );
    }
  }

  private async runTask(taskId: string): Promise<void> {
    const task = findTaskById(this.db, taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} not found`);
      return;
    }

    // Defensiva: si ya esta en waiting-waiter, no re-ejecutar
    if (task.status === 'waiting-waiter') {
      console.log(`[dispatcher] runTask skipped: task ${taskId} already in waiting-waiter`);
      return;
    }

    // Gate: verificar waiters pasivos pendientes
    const pendingWaiters = listPassiveWaitersForTask(this.db, taskId);
    if (pendingWaiters.length > 0) {
      updateTaskStatus(this.db, taskId, 'waiting-waiter', clockNow());
      console.log(`[dispatcher] Task ${taskId} -> waiting-waiter (${pendingWaiters.length} passive waiters pending)`);
      return;
    }

    // FIX race window: agregar al Set DESPUES del gate check
    // De esta forma solo tasks que efectivamente van a ejecutar ocupan slots
    this.activeWorkerIds.add(taskId);

    console.log(`[dispatcher] Running task ${taskId} (agent=${task.agent_id})`);

    // Crear execution
    const executionId = ulid();
    createExecution(this.db, {
      id: executionId,
      task_id: taskId,
      agent_id: task.agent_id,
      started_at: clockNow(),
      status: 'running',
    });

    // Actualizar task a running
    updateTaskStatus(this.db, taskId, 'running', clockNow());

    // Transicionar flow a running si esta queued
    const flow = findFlowById(this.db, task.flow_id);
    if (flow && flow.status === 'queued') {
      updateFlowStatus(this.db, task.flow_id, 'running', clockNow());
      console.log(`[dispatcher] Flow ${task.flow_id} -> running`);
    }

    try {
      // Parse input_json para extraer parametros
      let prompt = task.input_json;
      let permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' = 'acceptEdits';
      let maxTurns = 10;
      let addDir: string[] | undefined;
      let cwd: string | undefined;
      let timeoutMs: number | undefined;
      let inputSessionStrategy: 'flow-agent-task' | 'none' | undefined;

      try {
        const parsed = JSON.parse(task.input_json);
        if (typeof parsed === 'object' && parsed !== null) {
          if (typeof parsed.message === 'string') prompt = parsed.message;
          if (typeof parsed.permission_mode === 'string') {
            permissionMode = parsed.permission_mode as typeof permissionMode;
          }
          if (typeof parsed.max_turns === 'number') maxTurns = parsed.max_turns;
          if (Array.isArray(parsed.add_dir)) {
            addDir = parsed.add_dir.filter((d: unknown): d is string => typeof d === 'string');
          }
          if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
          if (typeof parsed.timeout_ms === 'number') timeoutMs = parsed.timeout_ms;

          // Parse session_strategy del input_json (override sobre env)
          if (typeof parsed.session_strategy === 'string') {
            if (['flow-agent-task', 'none'].includes(parsed.session_strategy)) {
              inputSessionStrategy = parsed.session_strategy as 'flow-agent-task' | 'none';
            } else {
              console.warn(
                `[dispatcher] Invalid session_strategy in input_json: "${parsed.session_strategy}" for task ${taskId}, using env default`
              );
            }
          }
        }
      } catch {
        // input_json no es JSON valido — usar tal cual como prompt
      }

      // ─────────────────────────────────────────────────────────────
      // Session strategy lookup (pre-run)
      // ─────────────────────────────────────────────────────────────

      // 1. Kill-switch check
      const sessionsDisabled = existsSync(`${STATE_DIR}/.SESSIONS_DISABLED`);

      // 2. Determinar estrategia efectiva (input_json override > kill-switch > env)
      let effectiveStrategy: 'flow-agent-task' | 'none' = inputSessionStrategy ?? SESSION_STRATEGY as 'flow-agent-task' | 'none';
      if (sessionsDisabled) {
        effectiveStrategy = 'none';
      }

      // 3. Lookup session
      let requestedSessionId: string | undefined;
      let sessionAction: 'new' | 'resume' | 'new-after-cap' | 'disabled' | 'fallback-after-expiry' = 'new';
      const strategyKey = `${task.flow_id}:${task.agent_id}:${task.id}`;

      if (sessionsDisabled) {
        sessionAction = 'disabled';
        console.log(`[dispatcher] session strategy=none action=disabled key=${strategyKey} task=${taskId}`);
      } else if (effectiveStrategy === 'none') {
        sessionAction = 'disabled';
        console.log(`[dispatcher] session strategy=none action=disabled key=${strategyKey} task=${taskId}`);
      } else {
        // effectiveStrategy === 'flow-agent-task'
        const existing = lookupSession(this.db, strategyKey, MAX_TURNS_PER_SESSION);

        if (existing && existing.session_id.trim().length > 0) {
          // Session encontrada y dentro del cap
          requestedSessionId = existing.session_id;
          sessionAction = 'resume';
          console.log(`[dispatcher] session strategy=${effectiveStrategy} action=resume key=${strategyKey} task=${taskId}`);
        } else {
          // No hay session o supero el cap. Checar si existia una fila previa.
          const previousSession = this.db
            .prepare(`SELECT session_id, turn_count FROM agent_sessions WHERE strategy_key = ?`)
            .get(strategyKey) as { session_id: string; turn_count: number } | undefined;

          if (previousSession && previousSession.turn_count >= MAX_TURNS_PER_SESSION) {
            sessionAction = 'new-after-cap';
            console.log(`[dispatcher] session strategy=${effectiveStrategy} action=new-after-cap key=${strategyKey} task=${taskId}`);
          } else {
            sessionAction = 'new';
            console.log(`[dispatcher] session strategy=${effectiveStrategy} action=new key=${strategyKey} task=${taskId}`);
          }
        }
      }

      // Determinar si es coordinator para agregar system prompt + tools
      let appendSystemPrompt: string | undefined;
      let allowedTools: string[] | undefined;
      if (task.agent_id === 'softwarefactory_coordinator') {
        appendSystemPrompt = getCoordinatorSystemPrompt(task.flow_id, prompt);
        // El coordinator necesita ejecutar Bash (npx tsx cli-tools.ts) sin pedir aprobacion.
        // Restringimos al script especifico para no abrir Bash completo.
        // Read se permite para que el coordinator pueda inspeccionar artefactos producidos
        // por tasks previas (logs, reportes) al tomar decisiones de planning.
        allowedTools = [
          'Read',
          'Glob',
          'Grep',
          `Bash(npx tsx ${CLI_TOOLS_PATH}:*)`,
        ];
      } else {
        // FIX #1: Todos los demas agentes necesitan permisos para escribir archivos
        // en sus working dirs sin pedir aprobacion humana (combinado con permissionMode='acceptEdits').
        allowedTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
      }

      // Coordinator NUNCA recibe cwd/add_dir al runner: debe correr desde el cwd
      // default del orchestrator para que cli-tools.ts resuelva la DB correctamente
      // via process.cwd(). Los valores se quedan en input_json para que cli-tools.ts
      // los lea como herencia hacia sub-tasks.
      const isCoordinator = task.agent_id === 'softwarefactory_coordinator';
      const runnerCwd = isCoordinator ? undefined : cwd;
      const runnerAddDir = isCoordinator ? undefined : addDir;

      // Invocar agente
      const result = await this.agentRunner.run({
        agentId: task.agent_id,
        prompt,
        permissionMode,
        maxTurns,
        appendSystemPrompt,
        allowedTools,
        addDir: runnerAddDir,
        cwd: runnerCwd,
        timeoutMs,
        sessionId: requestedSessionId,
        taskId: task.id,
        flowId: task.flow_id,
      });

      // FIX #3: Trackear PID del child process
      if (result.childPid !== undefined) {
        this.childPids.add(result.childPid);
      }

      const timestamp = clockNow();

      // FIX #3: Remover PID del Set cuando el agente termina
      if (result.childPid !== undefined) {
        this.childPids.delete(result.childPid);
      }

      // ─────────────────────────────────────────────────────────────
      // Session upsert (post-run)
      // ─────────────────────────────────────────────────────────────

      if (result.sessionId && result.sessionId.trim().length > 0 && effectiveStrategy === 'flow-agent-task') {
        // Detectar fallback: si pasamos un sessionId pero el runner retorno otro distinto
        if (requestedSessionId && requestedSessionId.trim().length > 0 && result.sessionId !== requestedSessionId) {
          console.log(
            `[dispatcher] session action=fallback-after-expiry old=${requestedSessionId} new=${result.sessionId} task=${taskId}`
          );
          sessionAction = 'fallback-after-expiry';
        }

        // Upsert session (siempre, exito o fallo)
        upsertSession(this.db, {
          strategy_key: strategyKey,
          session_id: result.sessionId,
          flow_id: task.flow_id,
          agent_id: task.agent_id,
          task_id: task.id,
          strategy: 'flow-agent-task',
        });
      }

      if (result.success) {
        // FIX #2: Validacion minima de artefactos — observabilidad para detectar falsos positivos
        this.validateTaskArtifacts(taskId, result.output);

        // FIX #2.2: Persistir session_action en output_json para telemetria SQL
        const enrichedOutput = this.enrichOutputWithSessionAction(result.output, sessionAction);

        // FIX #4 (waiter-loop nativo): si el agente CREO waiters pasivos durante su turno,
        // la task no debe marcarse como done — debe pasar a waiting-waiter. El dispatcher
        // la re-invocara via --resume cuando el operador fulfill cada waiter. Sin esto,
        // el patron prepare/refine en multiples rondas no funciona porque la task se
        // cierra antes de poder iterar.
        const pendingAfterRun = listPassiveWaitersForTask(this.db, taskId);
        if (pendingAfterRun.length > 0) {
          updateTaskStatus(this.db, taskId, 'waiting-waiter', timestamp);
          finishExecution(
            this.db,
            executionId,
            timestamp,
            'completed',
            result.tokensInput ?? 0,
            result.tokensOutput ?? 0,
          );
          console.log(
            `[dispatcher] Task ${taskId} → waiting-waiter (created ${pendingAfterRun.length} passive waiter(s) this turn; output preserved in execution)`,
          );
        } else {
          // Task exitosa sin waiters pendientes → done
          markTaskAsDone(this.db, taskId, enrichedOutput, timestamp);

          finishExecution(
            this.db,
            executionId,
            timestamp,
            'completed',
            result.tokensInput ?? 0,
            result.tokensOutput ?? 0,
          );

          // TODO(roman): persistir agent_conversations si result.sessionId y result.cost

          // Log especifico para coordinator
          if (task.agent_id === 'softwarefactory_coordinator' && result.output.includes('<<COORDINATOR_DONE:')) {
            console.log(`[dispatcher] Coordinator plan emitted by task ${taskId}`);
          }

          console.log(`[dispatcher] Task ${taskId} → done`);
        }
      } else {
        // Task fallida
        updateTaskStatus(this.db, taskId, 'failed', timestamp, result.error);

        finishExecution(
          this.db,
          executionId,
          timestamp,
          'failed',
          result.tokensInput ?? 0,
          result.tokensOutput ?? 0,
        );

        console.error(`[dispatcher] Task ${taskId} → failed: ${result.error}`);
      }
    } catch (err) {
      const timestamp = clockNow();
      const errorMsg = err instanceof Error ? err.message : String(err);

      updateTaskStatus(this.db, taskId, 'failed', timestamp, errorMsg);
      finishExecution(this.db, executionId, timestamp, 'failed', 0, 0);

      console.error(`[dispatcher] Task ${taskId} threw exception:`, err);
    }
  }

  /**
   * FIX #2.2: Enriquece output con session_action para telemetria SQL.
   * - Si el output es JSON valido, parsea, agrega _meta.session_action, serializa.
   * - Si NO es JSON, wrappea como { raw: <output>, _meta: { session_action } }.
   */
  private enrichOutputWithSessionAction(output: string, sessionAction: string): string {
    try {
      const parsed = JSON.parse(output);
      // Ya es JSON — agregar _meta
      const enriched = {
        ...parsed,
        _meta: {
          ...(parsed._meta ?? {}),
          session_action: sessionAction,
        },
      };
      return JSON.stringify(enriched);
    } catch {
      // NO es JSON — wrappear
      return JSON.stringify({
        raw: output,
        _meta: { session_action: sessionAction },
      });
    }
  }
}

// Entry point si se ejecuta directamente (no via CLI)
if (import.meta.url === `file://${process.argv[1]}`) {
  const dispatcher = new Dispatcher();

  process.on('SIGTERM', async () => {
    await dispatcher.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await dispatcher.stop();
    process.exit(0);
  });

  dispatcher.start().catch((err) => {
    console.error('[dispatcher] Fatal error:', err);
    process.exit(1);
  });
}
