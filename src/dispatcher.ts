// Dispatcher esqueleto — MVP Tier 1.
// Implementa tick A (selector de tasks ready) y tick E (consumer de eventos task.finished).
// Recovery minimo, kill-switch, heartbeat, graceful shutdown.

import { writeFileSync, existsSync } from 'node:fs';
import { openDb } from './db/connection.js';
import { makeAgentRunner } from './agent/index.js';
import { ulid } from './lib/ulid.js';
import { now as clockNow } from './lib/clock.js';
import {
  findTaskById,
  updateTaskStatus,
  markTaskAsDone,
  type TaskRow,
} from './db/dao/tasks.js';
import {
  createExecution,
  finishExecution,
} from './db/dao/executions.js';
import {
  listPendingEvents,
  markConsumed,
  type EventRow,
} from './db/dao/events.js';
import type Database from 'better-sqlite3';
import type { AgentRunner } from './agent/types.js';

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS ?? '3', 10);
const TICK_A_INTERVAL_MS = 500; // selector de tasks ready
const TICK_E_INTERVAL_MS = 250; // consumer de eventos
const KILL_TIMEOUT_MS = parseInt(process.env.KILL_TIMEOUT_MS ?? '30000', 10);
const STATE_DIR = process.env.STATE_DIR ?? 'state';

interface WorkerSlot {
  taskId: string;
  promise: Promise<void>;
}

export class Dispatcher {
  private db: Database.Database;
  private agentRunner: AgentRunner;
  private workers: WorkerSlot[] = [];
  private running = false;
  private tickATimer: NodeJS.Timeout | null = null;
  private tickETimer: NodeJS.Timeout | null = null;

  constructor(dbPath?: string) {
    this.db = openDb(dbPath);
    this.agentRunner = makeAgentRunner();
  }

  async start(): Promise<void> {
    console.log(`[dispatcher] Starting with MAX_WORKERS=${MAX_WORKERS}`);

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

    this.running = true;

    // Notificar a PM2 si esta corriendo bajo supervisor
    process.send?.('ready');

    // Iniciar ticks
    this.tickATimer = setInterval(() => this.tickA(), TICK_A_INTERVAL_MS);
    this.tickETimer = setInterval(() => this.tickE(), TICK_E_INTERVAL_MS);

    console.log('[dispatcher] Started');
  }

  async stop(): Promise<void> {
    console.log('[dispatcher] Stopping (graceful shutdown)...');
    this.running = false;

    // Detener ticks
    if (this.tickATimer) clearInterval(this.tickATimer);
    if (this.tickETimer) clearInterval(this.tickETimer);

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

    this.db.close();
    console.log('[dispatcher] Stopped');
  }

  // Tick A: selector de tasks ready (cada 500 ms)
  private tickA(): void {
    // Kill-switch check
    if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
      console.log('[dispatcher] Kill-switch detected, draining workers...');
      this.running = false;
      return;
    }

    // Heartbeat
    writeFileSync(`${STATE_DIR}/.heartbeat`, String(clockNow()));

    // Limpiar workers terminados
    this.workers = this.workers.filter((w) => {
      // Si el promise esta settled, ya no esta activo (no hay forma facil de chequearlo sin await,
      // pero el promise mismo se resolvera y dejara de estar en la lista cuando se haga cleanup)
      return true; // TODO(roman): mejorar con un Set de IDs activos
    });

    // Si no hay slots libres, saltar
    const freeSlots = MAX_WORKERS - this.workers.length;
    if (freeSlots <= 0) return;

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
      const promise = this.runTask(task.id).catch((err) => {
        console.error(`[dispatcher] Uncaught error running task ${task.id}:`, err);
      });

      this.workers.push({ taskId: task.id, promise });

      // Limpiar del array cuando termine
      promise.finally(() => {
        this.workers = this.workers.filter((w) => w.taskId !== task.id);
      });
    }
  }

  // Tick E: consumer de eventos task.finished (cada 250 ms)
  private tickE(): void {
    if (existsSync(`${STATE_DIR}/.KILLSWITCH`)) {
      return;
    }

    const pending = listPendingEvents(this.db, 50);

    for (const event of pending) {
      if (event.kind === 'task.finished') {
        this.handleTaskFinished(event);
      }

      // Marcar como consumido y appendear a events.jsonl
      markConsumed(this.db, event.id);
      this.appendToEventLog(event);
    }
  }

  private handleTaskFinished(event: EventRow): void {
    const payload = JSON.parse(event.payload_json) as { task_id: string };
    const taskId = payload.task_id;

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
  }

  private appendToEventLog(event: EventRow): void {
    // TODO(roman): implementar append a state/events.jsonl con hash
    // Por ahora solo log
    console.log(`[dispatcher] Event consumed: ${event.kind} (id=${event.id})`);
  }

  private async runTask(taskId: string): Promise<void> {
    const task = findTaskById(this.db, taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} not found`);
      return;
    }

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

    try {
      // Invocar agente
      const result = await this.agentRunner.run({
        agentId: task.agent_id,
        prompt: task.input_json,
        permissionMode: 'plan', // Modo restrictivo por defecto
        maxTurns: 10,
      });

      const timestamp = clockNow();

      if (result.success) {
        // Task exitosa → done
        markTaskAsDone(this.db, taskId, result.output, timestamp);

        finishExecution(
          this.db,
          executionId,
          timestamp,
          'completed',
          result.tokensInput ?? 0,
          result.tokensOutput ?? 0,
        );

        // TODO(roman): persistir agent_conversations si result.sessionId y result.cost

        console.log(`[dispatcher] Task ${taskId} → done`);
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
