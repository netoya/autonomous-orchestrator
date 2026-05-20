// Tests del dispatcher para session strategy (spec session-strategy).
// 7 casos de comportamiento:
// 1. flow-agent-task: retry hereda session
// 2. flow-agent-task: tasks distintas NO heredan
// 3. none: nunca hereda
// 4. fallback-after-expiry: actualiza tabla si sessionId distinto
// 5. coordinator-seed: nunca recibe session
// 6. kill-switch: fuerza none cuando .SESSIONS_DISABLED existe
// 7. turn-cap: rotacion despues de MAX_TURNS_PER_SESSION

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask, updateTaskStatus } from '../../db/dao/tasks.js';
import { MockAgentRunner } from '../../agent/mock.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import type Database from 'better-sqlite3';

const TEST_DB_PATH = resolve(process.cwd(), 'state/test-sessions.db');
const TEST_STATE_DIR = resolve(process.cwd(), 'state');
const KILL_SWITCH_PATH = resolve(TEST_STATE_DIR, '.SESSIONS_DISABLED');

describe('Dispatcher session strategy', () => {
  let db: Database.Database;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Backup env vars
    originalEnv = { ...process.env };

    // Asegurar que existe state/
    if (!existsSync(TEST_STATE_DIR)) {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
    }

    // Limpiar DB de test si existe
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    // Limpiar kill-switch si existe
    if (existsSync(KILL_SWITCH_PATH)) {
      unlinkSync(KILL_SWITCH_PATH);
    }

    // Abrir DB y aplicar migraciones manualmente (simplificado para tests)
    db = openDb(TEST_DB_PATH);

    // Aplicar schema minimo para tests
    db.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        status TEXT NOT NULL DEFAULT 'queued',
        autonomy TEXT NOT NULL DEFAULT 'L3',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        budget_json TEXT NOT NULL DEFAULT '{}',
        parent_flow_id TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        parent_task_id TEXT,
        stage TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        input_json TEXT NOT NULL,
        output_json TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        business_value INTEGER,
        estimated_minutes INTEGER,
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_milestone INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'finish-to-start',
        resolved_via_tag TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        child_pid INTEGER
      );

      CREATE TABLE waiters (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        authz_json TEXT NOT NULL DEFAULT '{}',
        timeout_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        value_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        fulfilled_by TEXT,
        fulfilled_at INTEGER,
        script_path TEXT,
        script_version TEXT,
        condition_kind TEXT,
        condition_params_json TEXT,
        poll_interval_ms INTEGER NOT NULL DEFAULT 5000,
        poll_schedule_json TEXT,
        poll_max_attempts INTEGER NOT NULL DEFAULT 100,
        check_count INTEGER NOT NULL DEFAULT 0,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        last_check_at INTEGER,
        last_check_result TEXT,
        next_check_at INTEGER,
        horizon TEXT NOT NULL DEFAULT 'short',
        max_lifetime_days INTEGER,
        context_snapshot_hash TEXT,
        lease_until INTEGER,
        lease_holder TEXT,
        last_checked INTEGER
      );

      CREATE TABLE agent_sessions (
        strategy_key TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        agent_id     TEXT NOT NULL,
        task_id      TEXT,
        strategy     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        turn_count   INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS agent_sessions_flow_idx ON agent_sessions(flow_id);
      CREATE INDEX IF NOT EXISTS agent_sessions_task_idx ON agent_sessions(task_id) WHERE task_id IS NOT NULL;

      CREATE TRIGGER tasks_done_trigger
      AFTER UPDATE OF status ON tasks
      WHEN NEW.status = 'done' AND OLD.status <> 'done'
      BEGIN
        INSERT INTO events(ts, kind, payload_json)
        VALUES (
          strftime('%s','now')*1000,
          'task.finished',
          json_object(
            'task_id', NEW.id,
            'flow_id', NEW.flow_id,
            'stage', NEW.stage,
            'agent_id', NEW.agent_id,
            'tags', NEW.tags_json
          )
        );
      END;
    `);
  });

  afterEach(() => {
    // Restore env vars
    process.env = originalEnv;

    if (db) {
      db.close();
    }
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    if (existsSync(KILL_SWITCH_PATH)) {
      unlinkSync(KILL_SWITCH_PATH);
    }
  });

  it('flow-agent-task: retry hereda session', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    // Crear flow + task ready
    createFlow(db, {
      id: flowId,
      name: 'test-retry-session',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'task-A',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'first attempt' }),
      idempotency_key: `${flowId}-task-A`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(TEST_DB_PATH);

    // Configurar mock para devolver sessionId en la 1ra invocacion
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.sessionIdProvider = (params, callIndex) => {
      if (callIndex === 0) return 'sess-1';
      return 'sess-1'; // misma session para retry
    };
    runner.seed('softwarefactory_mateo', 'first attempt', { output: 'Done' });
    runner.seed('softwarefactory_mateo', 'retry attempt', { output: 'Done retry' });

    await dispatcher.start();

    // Esperar a que procese la 1ra vez
    await new Promise((r) => setTimeout(r, 1500));

    await dispatcher.stop();

    // Verificar que el mock recibio SIN sessionId en la 1ra invocacion
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Marcar como failed y "retry" (resetear status a ready manualmente)
    db = openDb(TEST_DB_PATH);
    updateTaskStatus(db, taskId, 'ready', now());
    db.close();

    // Resetear el mock pero mantener sessionIdProvider
    const provider = runner.sessionIdProvider;
    runner.reset();
    runner.sessionIdProvider = provider;
    runner.seed('softwarefactory_mateo', 'first attempt', { output: 'Done retry' });

    // Run #2: dispatcher procesa retry
    const dispatcher2 = new Dispatcher(TEST_DB_PATH);
    (dispatcher2 as any).agentRunner = runner; // reusar mismo mock

    await dispatcher2.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher2.stop();

    // Verificar que el mock recibio CON sessionId en la 2da invocacion
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBe('sess-1');

    db = openDb(TEST_DB_PATH);
    const session = db
      .prepare('SELECT * FROM agent_sessions WHERE strategy_key = ?')
      .get(`${flowId}:softwarefactory_mateo:${taskId}`) as any;

    expect(session).toBeDefined();
    expect(session.session_id).toBe('sess-1');
    expect(session.turn_count).toBe(2); // 1ra + retry
  });

  it('flow-agent-task: tasks distintas del mismo agente NO heredan', async () => {
    const flowId = ulid();
    const taskAId = ulid();
    const taskBId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-no-share-session',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task A
    createTask(db, {
      id: taskAId,
      flow_id: flowId,
      stage: 'task-A',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'task A' }),
      idempotency_key: `${flowId}-task-A`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.sessionIdProvider = (params, callIndex) => {
      if (callIndex === 0) return 'sess-A';
      if (callIndex === 1) return 'sess-B';
      return 'sess-default';
    };
    runner.seed('softwarefactory_mateo', 'task A', { output: 'Done A' });
    runner.seed('softwarefactory_mateo', 'task B', { output: 'Done B' });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    // Verificar que task A se proceso
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Crear task B (mismo agente, distinto task_id)
    db = openDb(TEST_DB_PATH);
    createTask(db, {
      id: taskBId,
      flow_id: flowId,
      stage: 'task-B',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'task B' }),
      idempotency_key: `${flowId}-task-B`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });
    db.close();

    // Resetear calls pero mantener sessionIdProvider
    const provider = runner.sessionIdProvider;
    runner.calls = [];
    runner.sessionIdProvider = provider;

    const dispatcher2 = new Dispatcher(TEST_DB_PATH);
    (dispatcher2 as any).agentRunner = runner;

    await dispatcher2.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher2.stop();

    // Verificar que task B NO recibio sessionId (distinto task_id)
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Verificar que hay 2 filas distintas en agent_sessions
    db = openDb(TEST_DB_PATH);
    const sessions = db.prepare('SELECT * FROM agent_sessions').all();
    expect(sessions.length).toBe(2);
  });

  it('none: nunca pasa sessionId', async () => {
    // Usar input_json override para forzar session_strategy=none
    // (env var no funciona porque SESSION_STRATEGY se lee como constante global)
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-none-strategy',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'task-none',
      agent_id: 'softwarefactory_valeria',
      status: 'ready',
      input_json: JSON.stringify({ message: 'test none', session_strategy: 'none' }),
      idempotency_key: `${flowId}-task-none`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.seed('softwarefactory_valeria', 'test none', { output: 'Done' });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    // Verificar que NO recibio sessionId
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Marcar como retry con mismo override
    db = openDb(TEST_DB_PATH);
    updateTaskStatus(db, taskId, 'ready', now());
    db.close();

    runner.reset();
    runner.seed('softwarefactory_valeria', 'test none', { output: 'Done retry' });

    const dispatcher2 = new Dispatcher(TEST_DB_PATH);
    (dispatcher2 as any).agentRunner = runner;

    await dispatcher2.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher2.stop();

    // Verificar que tampoco recibio sessionId en retry
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Verificar que NO se creo fila en agent_sessions
    db = openDb(TEST_DB_PATH);
    const sessions = db.prepare('SELECT * FROM agent_sessions').all();
    expect(sessions.length).toBe(0);
  });

  it('fallback-after-expiry: detecta y actualiza', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-fallback',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'task-fallback',
      agent_id: 'softwarefactory_roman',
      status: 'ready',
      input_json: JSON.stringify({ message: 'fallback test' }),
      idempotency_key: `${flowId}-task-fallback`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    // Run #1: devolver sessionId 'sess-1'
    // Run #2: si le pasan sessionId (resume), devolver 'sess-2' (simulando expiry server-side)
    runner.sessionIdProvider = (params) => {
      if (params.sessionId) {
        // Retry con resume — servidor ignora y crea nueva sesion
        return 'sess-2';
      }
      // Primera invocacion sin resume
      return 'sess-1';
    };

    runner.seed('softwarefactory_roman', 'fallback test', { output: 'Done 1' });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    // Verificar que se guardo sess-1
    db = openDb(TEST_DB_PATH);
    let session = db
      .prepare('SELECT * FROM agent_sessions WHERE strategy_key = ?')
      .get(`${flowId}:softwarefactory_roman:${taskId}`) as any;
    expect(session.session_id).toBe('sess-1');

    // Marcar como retry
    updateTaskStatus(db, taskId, 'ready', now());
    db.close();

    // Resetear mock pero mantener sessionIdProvider
    const provider = runner.sessionIdProvider;
    runner.reset();
    runner.sessionIdProvider = provider;
    runner.seed('softwarefactory_roman', 'fallback test', { output: 'Done 2' });

    const dispatcher2 = new Dispatcher(TEST_DB_PATH);
    (dispatcher2 as any).agentRunner = runner;

    await dispatcher2.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher2.stop();

    // Verificar que recibio sessionId='sess-1' pero devolvio 'sess-2'
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBe('sess-1');

    // Verificar que la tabla se actualizo con sess-2 y turn_count reseteado a 1
    db = openDb(TEST_DB_PATH);
    session = db
      .prepare('SELECT * FROM agent_sessions WHERE strategy_key = ?')
      .get(`${flowId}:softwarefactory_roman:${taskId}`) as any;
    expect(session.session_id).toBe('sess-2');
    expect(session.turn_count).toBe(1);
  });

  it('coordinator-seed: nunca recibe sessionId aunque haya fila previa', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-coordinator-seed',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Manipular DB directamente: insertar fila vieja con strategy_key que incluye task_id
    // Esto simula algo raro que paso (no deberia pasar, pero probamos que no afecta)
    db.prepare(`
      INSERT INTO agent_sessions (strategy_key, session_id, flow_id, agent_id, task_id, strategy, created_at, last_used_at, turn_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      `${flowId}:softwarefactory_coordinator:old-task-id`,
      'sess-old',
      flowId,
      'softwarefactory_coordinator',
      'old-task-id',
      'flow-agent-task',
      timestamp,
      timestamp,
    );

    // Crear coordinator-seed task con NUEVO task_id
    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'coordinate-seed',
      agent_id: 'softwarefactory_coordinator',
      status: 'ready',
      input_json: JSON.stringify({ message: 'coordinator seed' }),
      idempotency_key: `${flowId}-coordinate-seed`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.sessionIdProvider = () => 'sess-new-coordinator';
    runner.seed('softwarefactory_coordinator', 'coordinator seed', { output: 'Plan created' });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    // Verificar que NO recibio sessionId (porque la clave incluye task_id y es distinto)
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Verificar que ahora hay 2 filas en agent_sessions
    db = openDb(TEST_DB_PATH);
    const sessions = db.prepare('SELECT * FROM agent_sessions').all();
    expect(sessions.length).toBe(2); // old-task-id y el nuevo taskId
  });

  it('kill-switch: state/.SESSIONS_DISABLED fuerza none', async () => {
    // Crear kill-switch file
    writeFileSync(KILL_SWITCH_PATH, '');

    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-kill-switch',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'task-kill-switch',
      agent_id: 'softwarefactory_dante',
      status: 'ready',
      input_json: JSON.stringify({ message: 'kill switch test' }),
      idempotency_key: `${flowId}-task-kill-switch`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    // Spy on console.log para verificar el log de "action=disabled"
    const consoleLogSpy = vi.spyOn(console, 'log');

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.seed('softwarefactory_dante', 'kill switch test', { output: 'Done' });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    // Verificar que NO recibio sessionId
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Verificar que NO se creo fila en agent_sessions
    db = openDb(TEST_DB_PATH);
    const sessions = db.prepare('SELECT * FROM agent_sessions').all();
    expect(sessions.length).toBe(0);

    // Verificar que el log contiene "action=disabled"
    const logCalls = consoleLogSpy.mock.calls.map((call) => call.join(' '));
    const sessionLog = logCalls.find((log) => log.includes('session') && log.includes('action=disabled'));
    expect(sessionLog).toBeDefined();

    consoleLogSpy.mockRestore();
  });

  it('turn-cap: rotacion despues de MAX_TURNS_PER_SESSION', { timeout: 15000 }, async () => {
    // Nota: MAX_TURNS_PER_SESSION es constante global (default 50).
    // Para testear turn-cap, vamos a manipular la DB directamente para simular turn_count >= 50.

    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-turn-cap',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'task-turn-cap',
      agent_id: 'softwarefactory_lucas',
      status: 'ready',
      input_json: JSON.stringify({ message: 'turn cap test' }),
      idempotency_key: `${flowId}-task-turn-cap`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    // Provider que devuelve 'sess-cap' en el primer run, 'sess-new' despues de cap
    let runCount = 0;
    runner.sessionIdProvider = (params) => {
      runCount++;
      return params.sessionId ? 'sess-cap' : (runCount === 1 ? 'sess-cap' : 'sess-new');
    };
    runner.seed('softwarefactory_lucas', 'turn cap test', { output: 'Done' });

    // Run 1: primera invocacion (turn_count=1)
    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined(); // primera vez

    // Manipular DB para simular turn_count=50 (limite)
    db = openDb(TEST_DB_PATH);
    db.prepare(`
      UPDATE agent_sessions
      SET turn_count = 50
      WHERE strategy_key = ?
    `).run(`${flowId}:softwarefactory_lucas:${taskId}`);

    let session = db
      .prepare('SELECT * FROM agent_sessions WHERE strategy_key = ?')
      .get(`${flowId}:softwarefactory_lucas:${taskId}`) as any;
    expect(session.turn_count).toBe(50); // confirm DB state

    // Run 2: turn_count >= MAX_TURNS_PER_SESSION (50), debe forzar nueva sesion
    updateTaskStatus(db, taskId, 'ready', now());
    db.close();

    const provider = runner.sessionIdProvider;
    runner.calls = [];
    runner.sessionIdProvider = provider;

    // Spy on console.log para verificar "action=new-after-cap"
    const consoleLogSpy = vi.spyOn(console, 'log');

    const dispatcher2 = new Dispatcher(TEST_DB_PATH);
    (dispatcher2 as any).agentRunner = runner;
    await dispatcher2.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher2.stop();

    // Verificar que NO recibio sessionId (rotacion por cap)
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.sessionId).toBeUndefined();

    // Verificar que el log contiene "action=new-after-cap"
    const logCalls = consoleLogSpy.mock.calls.map((call) => call.join(' '));
    const capLog = logCalls.find((log) => log.includes('action=new-after-cap'));
    expect(capLog).toBeDefined();

    // Verificar que la tabla se actualizo con el nuevo sessionId y turn_count reseteado
    db = openDb(TEST_DB_PATH);
    session = db
      .prepare('SELECT * FROM agent_sessions WHERE strategy_key = ?')
      .get(`${flowId}:softwarefactory_lucas:${taskId}`) as any;
    expect(session.session_id).toBe('sess-new');
    expect(session.turn_count).toBe(1); // Fix aplicado: reset a 1 cuando session_id cambia

    consoleLogSpy.mockRestore();
  });
});
