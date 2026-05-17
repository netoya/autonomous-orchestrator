// Tests E2E para flows con waiters pasivos.
// Test 1: task con waiter pasivo queda en waiting-waiter.
// Test 2: fulfillWaiter + tick E -> task transiciona a ready.
// Test 3: flow con todas las tasks done pasa a completed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask, findTaskById } from '../../db/dao/tasks.js';
import { createPassiveWaiter, fulfillWaiter, findWaiterById } from '../../db/dao/waiters.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import { createTestSchema } from '../helpers/test-schema.js';
import type Database from 'better-sqlite3';

const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('Flow con waiter pasivo', () => {
  let db: Database.Database;
  let testDbPath: string;

  beforeEach(() => {
    // Asegurar que existe state/
    if (!existsSync(TEST_STATE_DIR)) {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (testDbPath && existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it('Task con waiter pasivo queda en waiting-waiter', async () => {
    testDbPath = resolve(TEST_STATE_DIR, 'test-waiter-waiting.db');
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Setup: crear DB con migraciones
    db = openDb(testDbPath);
    createTestSchema(db);

    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    // Crear flow + task ready + waiter pasivo
    createFlow(db, {
      id: flowId,
      name: 'test-flow-waiter',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test',
      agent_id: 'softwarefactory_camila',
      status: 'ready',
      input_json: JSON.stringify({ message: 'waiting' }),
      idempotency_key: `${flowId}-test`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'approval',
      kind: 'approve-text',
      prompt: 'Aprobar test',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(testDbPath);
    await dispatcher.start();

    // Esperar ticks
    await new Promise((r) => setTimeout(r, 1500));

    await dispatcher.stop();

    // Verificar resultado
    db = openDb(testDbPath);

    const task = findTaskById(db, taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('waiting-waiter');

    // No debe haber executions para esta task
    const executions = db.prepare('SELECT COUNT(*) as count FROM executions WHERE task_id = ?').get(taskId) as { count: number };
    expect(executions.count).toBe(0);

    // Waiter sigue en waiting
    const waiter = findWaiterById(db, waiterId);
    expect(waiter).toBeDefined();
    expect(waiter!.status).toBe('waiting');
  });

  it('fulfillWaiter + tick E -> task transiciona a ready y luego done', async () => {
    testDbPath = resolve(TEST_STATE_DIR, 'test-waiter-fulfill.db');
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Setup: DB con task en waiting-waiter
    db = openDb(testDbPath);
    createTestSchema(db);

    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-fulfill',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task en waiting-waiter
    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test',
      agent_id: 'softwarefactory_camila',
      status: 'waiting-waiter',
      input_json: JSON.stringify({ message: 'waiting' }),
      idempotency_key: `${flowId}-test`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'approval',
      kind: 'approve-text',
      prompt: 'Aprobar test',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(testDbPath);
    await dispatcher.start();

    // Esperar 500ms para que el dispatcher este corriendo
    await new Promise((r) => setTimeout(r, 500));

    // Fulfill waiter
    db = openDb(testDbPath);
    fulfillWaiter(db, waiterId, JSON.stringify({ decision: 'approved', reviewed_by: 'test' }), 'test-user', now());
    db.close();

    // Esperar 2s para que tick E lo procese y la task se ejecute
    await new Promise((r) => setTimeout(r, 2000));

    await dispatcher.stop();

    // Verificar resultado
    db = openDb(testDbPath);

    const waiter = findWaiterById(db, waiterId);
    expect(waiter).toBeDefined();
    expect(waiter!.status).toBe('fulfilled');

    const task = findTaskById(db, taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('done'); // La task ya se ejecuto

    // Debe existir 1 execution
    const executions = db.prepare('SELECT COUNT(*) as count FROM executions WHERE task_id = ?').get(taskId) as { count: number };
    expect(executions.count).toBe(1);

    // Evento waiter.fulfilled debe estar consumido
    const waiterEvent = db.prepare("SELECT * FROM events WHERE kind = 'waiter.fulfilled' ORDER BY id DESC LIMIT 1").get() as any;
    expect(waiterEvent).toBeDefined();
    expect(waiterEvent.consumed).toBe(1);
  });

  it('Flow con todas las tasks done pasa a completed', async () => {
    testDbPath = resolve(TEST_STATE_DIR, 'test-flow-completed.db');
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Setup: flow con 2 tasks ready SIN deps
    db = openDb(testDbPath);
    createTestSchema(db);

    const flowId = ulid();
    const task1Id = ulid();
    const task2Id = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-complete',
      status: 'running',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: task1Id,
      flow_id: flowId,
      stage: 'task1',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'task 1' }),
      idempotency_key: `${flowId}-task1`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    createTask(db, {
      id: task2Id,
      flow_id: flowId,
      stage: 'task2',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'task 2' }),
      idempotency_key: `${flowId}-task2`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(testDbPath);
    await dispatcher.start();

    // Esperar 2s para que procese ambas tasks
    await new Promise((r) => setTimeout(r, 2000));

    await dispatcher.stop();

    // Verificar resultado
    db = openDb(testDbPath);

    const task1 = findTaskById(db, task1Id);
    expect(task1).toBeDefined();
    expect(task1!.status).toBe('done');

    const task2 = findTaskById(db, task2Id);
    expect(task2).toBeDefined();
    expect(task2!.status).toBe('done');

    // Flow debe estar en completed
    const flow = db.prepare('SELECT * FROM flows WHERE id = ?').get(flowId) as any;
    expect(flow).toBeDefined();
    expect(flow.status).toBe('completed');

    // Debe existir evento flow.completed
    const flowEvent = db.prepare("SELECT * FROM events WHERE kind = 'flow.completed' ORDER BY id DESC LIMIT 1").get() as any;
    expect(flowEvent).toBeDefined();
    expect(flowEvent.consumed).toBe(1);
  });

  it('Fulfill de waiter huerfano NO regresa task done a ready (regression test)', async () => {
    testDbPath = resolve(TEST_STATE_DIR, 'test-waiter-done-orphan.db');
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Setup: DB con task ya done + waiter huerfano waiting
    db = openDb(testDbPath);
    createTestSchema(db);

    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-orphan-waiter',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task YA esta done (fue completada manualmente o por otro path)
    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test',
      agent_id: 'softwarefactory_camila',
      status: 'done',
      input_json: JSON.stringify({ message: 'already done' }),
      output_json: JSON.stringify({ result: 'completed manually' }),
      idempotency_key: `${flowId}-test`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    // Waiter huerfano todavia en waiting (creado antes de que la task se marcara done)
    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'approval',
      kind: 'approve-text',
      prompt: 'Aprobar test (huerfano)',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(testDbPath);
    await dispatcher.start();

    // Esperar 500ms para que el dispatcher este corriendo
    await new Promise((r) => setTimeout(r, 500));

    // Fulfill waiter huerfano
    db = openDb(testDbPath);
    fulfillWaiter(db, waiterId, JSON.stringify({ decision: 'approved' }), 'test-user', now());
    db.close();

    // Esperar 2s para que tick E lo procese
    await new Promise((r) => setTimeout(r, 2000));

    await dispatcher.stop();

    // Verificar resultado
    db = openDb(testDbPath);

    const waiter = findWaiterById(db, waiterId);
    expect(waiter).toBeDefined();
    expect(waiter!.status).toBe('fulfilled');

    // FIX: La task debe seguir en 'done', NO regresar a 'ready'
    const task = findTaskById(db, taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('done');

    // NO debe haber executions adicionales (el fulfill NO debe haber disparado re-ejecucion)
    const executions = db.prepare('SELECT COUNT(*) as count FROM executions WHERE task_id = ?').get(taskId) as { count: number };
    expect(executions.count).toBe(0);

    // Evento waiter.fulfilled debe estar consumido
    const waiterEvent = db.prepare("SELECT * FROM events WHERE kind = 'waiter.fulfilled' ORDER BY id DESC LIMIT 1").get() as any;
    expect(waiterEvent).toBeDefined();
    expect(waiterEvent.consumed).toBe(1);
  });
});
