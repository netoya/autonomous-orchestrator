// Test del Tick G: re-invocacion automatica del coordinator cuando una task falla.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask, updateTaskStatus } from '../../db/dao/tasks.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import type Database from 'better-sqlite3';

const TEST_DB_PATH = resolve(process.cwd(), 'state/test-tick-g.db');
const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('Tick G - Coordinator recovery', () => {
  let db: Database.Database;

  beforeEach(async () => {
    if (!existsSync(TEST_STATE_DIR)) {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
    }

    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    db = openDb(TEST_DB_PATH);

    // Schema minimo
    db.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        status TEXT NOT NULL DEFAULT 'queued',
        autonomy TEXT NOT NULL DEFAULT 'L3',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        budget_json TEXT NOT NULL DEFAULT '{}'
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

      CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key);

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
        tokens_output INTEGER NOT NULL DEFAULT 0
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
    if (db) {
      db.close();
    }
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it('Tick G crea task coordinator-recovery para task failed sin recovery previo', async () => {
    const flowId = ulid();
    const failedTaskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-with-failure',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Crear task fallida
    createTask(db, {
      id: failedTaskId,
      flow_id: flowId,
      stage: 'impl-backend',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'implement backend' }),
      idempotency_key: `${flowId}-impl-backend`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 5,
    });

    // Marcar como failed
    updateTaskStatus(db, failedTaskId, 'failed', timestamp, 'claude-exit-1: timeout');

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar ejecucion manual de tickG (en lugar de esperar 30s)
    (dispatcher as any).tickG();

    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    // Verificar que se creo una task coordinator-recovery
    db = openDb(TEST_DB_PATH);

    const recoveryTasks = db
      .prepare(
        `SELECT * FROM tasks
         WHERE flow_id = ?
           AND agent_id = 'softwarefactory_coordinator'
           AND parent_task_id = ?`,
      )
      .all(flowId, failedTaskId) as any[];

    expect(recoveryTasks.length).toBe(1);

    const recovery = recoveryTasks[0];
    expect(recovery.stage).toBe('coordinate-recovery-impl-backend');
    expect(recovery.status).toBe('ready');
    expect(recovery.priority).toBe(10);

    // Verificar que el input_json contiene el contexto de la falla
    const inputJson = JSON.parse(recovery.input_json);
    expect(inputJson.message).toContain('Task fallida: impl-backend');
    expect(inputJson.message).toContain('Agente: softwarefactory_mateo');
    expect(inputJson.message).toContain('Error: claude-exit-1: timeout');
    expect(inputJson.permission_mode).toBe('acceptEdits');
    expect(inputJson.max_turns).toBe(30);
  });

  it('Tick G NO duplica coordinator-recovery si ya existe uno running', async () => {
    const flowId = ulid();
    const failedTaskId = ulid();
    const recoveryTaskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-duplicate-check',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task fallida
    createTask(db, {
      id: failedTaskId,
      flow_id: flowId,
      stage: 'impl-frontend',
      agent_id: 'softwarefactory_valeria',
      status: 'failed',
      input_json: JSON.stringify({ message: 'implement frontend' }),
      idempotency_key: `${flowId}-impl-frontend`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 5,
    });

    // Ya existe un coordinator-recovery running
    createTask(db, {
      id: recoveryTaskId,
      flow_id: flowId,
      parent_task_id: failedTaskId,
      stage: 'coordinate-recovery-impl-frontend',
      agent_id: 'softwarefactory_coordinator',
      status: 'running',
      input_json: JSON.stringify({ message: 'recovery in progress' }),
      idempotency_key: `${flowId}-coordinate-recovery-impl-frontend`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 10,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar ejecucion manual de tickG
    (dispatcher as any).tickG();

    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    db = openDb(TEST_DB_PATH);

    const recoveryTasks = db
      .prepare(
        `SELECT * FROM tasks
         WHERE flow_id = ?
           AND agent_id = 'softwarefactory_coordinator'
           AND parent_task_id = ?`,
      )
      .all(flowId, failedTaskId) as any[];

    // Solo debe haber UNA (la que ya existia)
    expect(recoveryTasks.length).toBe(1);
    expect(recoveryTasks[0].id).toBe(recoveryTaskId);
  });

  it('Tick G sobrevive si hay colision de idempotency_key (dispatcher no crashea)', async () => {
    const flowId = ulid();
    const failedTaskId = ulid();
    const existingRecoveryId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-idempotency-collision',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task fallida
    createTask(db, {
      id: failedTaskId,
      flow_id: flowId,
      stage: 'impl-devops',
      agent_id: 'softwarefactory_dante',
      status: 'failed',
      input_json: JSON.stringify({ message: 'setup CI' }),
      idempotency_key: `${flowId}-impl-devops`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 5,
    });

    // Simular que ya existe un coordinator-recovery con estado 'cancelled' o 'failed'
    // (por lo que la query NOT EXISTS lo ignora y tickG intenta crear uno nuevo)
    createTask(db, {
      id: existingRecoveryId,
      flow_id: flowId,
      parent_task_id: failedTaskId,
      stage: 'coordinate-recovery-impl-devops',
      agent_id: 'softwarefactory_coordinator',
      status: 'cancelled', // Estado NO incluido en el NOT EXISTS (queued,ready,running,done)
      input_json: JSON.stringify({ message: 'recovery attempt 1' }),
      idempotency_key: `${flowId}-coordinate-recovery-impl-devops`, // Misma idempotency_key
      created_at: timestamp - 1000,
      updated_at: timestamp - 1000,
      priority: 10,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar tickG (deberia detectar la task failed, intentar insertar y atrapar SQLITE_CONSTRAINT_UNIQUE)
    (dispatcher as any).tickG();
    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    db = openDb(TEST_DB_PATH);

    const recoveryTasks = db
      .prepare(
        `SELECT * FROM tasks
         WHERE flow_id = ?
           AND agent_id = 'softwarefactory_coordinator'
           AND parent_task_id = ?`,
      )
      .all(flowId, failedTaskId) as any[];

    // Solo deberia haber UNA task (la existente con estado cancelled)
    expect(recoveryTasks.length).toBe(1);
    expect(recoveryTasks[0].id).toBe(existingRecoveryId);
    expect(recoveryTasks[0].status).toBe('cancelled');
  });

  // FIX #2 (P0): Test para limite de profundidad de recovery
  it('Tick G detecta task coordinate-recovery-* fallida y crea waiter en vez de recursion', async () => {
    const flowId = ulid();
    const originalTaskId = ulid();
    const recoveryTaskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-recursion-limit',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task original (la que fallo primero)
    createTask(db, {
      id: originalTaskId,
      flow_id: flowId,
      stage: 'impl-backend',
      agent_id: 'softwarefactory_mateo',
      status: 'failed',
      input_json: JSON.stringify({ message: 'implement backend' }),
      idempotency_key: `${flowId}-impl-backend`,
      created_at: timestamp - 2000,
      updated_at: timestamp - 2000,
      priority: 5,
    });

    // Coordinator-recovery que intento recuperar la task original, pero tambien fallo
    createTask(db, {
      id: recoveryTaskId,
      flow_id: flowId,
      parent_task_id: originalTaskId,
      stage: 'coordinate-recovery-impl-backend',
      agent_id: 'softwarefactory_coordinator',
      status: 'failed',
      input_json: JSON.stringify({ message: 'recovery attempt' }),
      idempotency_key: `${flowId}-coordinate-recovery-impl-backend`,
      created_at: timestamp - 1000,
      updated_at: timestamp - 1000,
      priority: 10,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar ejecucion manual de tickG
    (dispatcher as any).tickG();

    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    db = openDb(TEST_DB_PATH);

    // NO debe haber creado un coordinate-recovery-coordinate-recovery-*
    const doubleRecoveryTasks = db
      .prepare(
        `SELECT * FROM tasks
         WHERE flow_id = ?
           AND agent_id = 'softwarefactory_coordinator'
           AND stage LIKE 'coordinate-recovery-coordinate-recovery-%'`,
      )
      .all(flowId) as any[];

    expect(doubleRecoveryTasks.length).toBe(0);

    // EN CAMBIO debe haber creado un waiter pasivo para decision humana
    const waiters = db
      .prepare(
        `SELECT * FROM waiters
         WHERE flow_id = ?
           AND task_id = ?
           AND step_id = 'recovery-recursion-block'`,
      )
      .all(flowId, recoveryTaskId) as any[];

    expect(waiters.length).toBe(1);

    const waiter = waiters[0];
    expect(waiter.mode).toBe('passive');
    expect(waiter.kind).toBe('approve-text');
    expect(waiter.status).toBe('waiting');
    expect(waiter.prompt).toContain('Tick G detecto recursion');
    expect(waiter.prompt).toContain('coordinate-recovery-impl-backend');

    // Validar schema JSON del waiter
    const schema = JSON.parse(waiter.schema_json);
    expect(schema.properties.action.enum).toEqual(['abort', 'manual', 'skip']);
  });
});
