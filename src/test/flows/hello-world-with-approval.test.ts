// Test E2E completo para hello-world-with-approval.
// Verifica el flujo completo: greet → approve (waiter) → finalize → flow completed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createHelloWorldFlow } from '../../flows/hello-world-with-approval.js';
import { findTaskById } from '../../db/dao/tasks.js';
import { findFlowById } from '../../db/dao/flows.js';
import { findWaitingByFlow, fulfillWaiter } from '../../db/dao/waiters.js';
import { now } from '../../lib/clock.js';
import { createTestSchema } from '../helpers/test-schema.js';
import type Database from 'better-sqlite3';

const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('hello-world-with-approval E2E', () => {
  let db: Database.Database;
  let testDbPath: string;

  beforeEach(() => {
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

  it('Flow completo: greet → approve (waiter) → finalize → completed', async () => {
    testDbPath = resolve(TEST_STATE_DIR, 'test-hello-world-e2e.db');
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Setup: crear DB con migraciones
    db = openDb(testDbPath);
    createTestSchema(db);

    // Crear flow usando la funcion del ejemplo
    const flowId = createHelloWorldFlow({ db });

    // Obtener IDs de las tasks
    const tasks = db.prepare('SELECT * FROM tasks WHERE flow_id = ? ORDER BY created_at').all(flowId) as any[];
    expect(tasks.length).toBe(3);

    const taskGreet = tasks.find((t: any) => t.stage === 'greet');
    const taskApprove = tasks.find((t: any) => t.stage === 'approve');
    const taskFinalize = tasks.find((t: any) => t.stage === 'finalize');

    expect(taskGreet).toBeDefined();
    expect(taskApprove).toBeDefined();
    expect(taskFinalize).toBeDefined();

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(testDbPath);
    await dispatcher.start();

    // Esperar 2s para que procese task greet
    await new Promise((r) => setTimeout(r, 2000));

    // Verificar estado intermedio
    db = openDb(testDbPath);

    const greetTask = findTaskById(db, taskGreet!.id);
    expect(greetTask).toBeDefined();
    expect(greetTask!.status).toBe('done');

    const approveTask = findTaskById(db, taskApprove!.id);
    expect(approveTask).toBeDefined();
    expect(approveTask!.status).toBe('waiting-waiter');

    const finalizeTask = findTaskById(db, taskFinalize!.id);
    expect(finalizeTask).toBeDefined();
    expect(finalizeTask!.status).toBe('queued'); // Depende de approve

    const flow1 = findFlowById(db, flowId);
    expect(flow1).toBeDefined();
    expect(flow1!.status).toBe('running');

    // Obtener waiter
    const waiters = findWaitingByFlow(db, flowId);
    expect(waiters.length).toBe(1);
    const waiterId = waiters[0]!.id;

    // Fulfill waiter
    fulfillWaiter(db, waiterId, JSON.stringify({ decision: 'approved', reviewed_by: 'test' }), 'test-user', now());

    db.close();

    // Esperar 2s para que tick E procese el fulfill y se ejecuten approve + finalize
    await new Promise((r) => setTimeout(r, 2000));

    await dispatcher.stop();

    // Verificar estado final
    db = openDb(testDbPath);

    const finalGreet = findTaskById(db, taskGreet!.id);
    expect(finalGreet!.status).toBe('done');

    const finalApprove = findTaskById(db, taskApprove!.id);
    expect(finalApprove!.status).toBe('done');

    const finalFinalize = findTaskById(db, taskFinalize!.id);
    expect(finalFinalize!.status).toBe('done');

    const finalFlow = findFlowById(db, flowId);
    expect(finalFlow!.status).toBe('completed');

    // Verificar eventos
    const allEvents = db.prepare('SELECT * FROM events ORDER BY id').all() as any[];

    // Debe haber 3x task.finished (greet, approve, finalize)
    const taskFinishedEvents = allEvents.filter((e: any) => e.kind === 'task.finished');
    expect(taskFinishedEvents.length).toBe(3);
    expect(taskFinishedEvents.every((e: any) => e.consumed === 1)).toBe(true);

    // 1x waiter.fulfilled
    const waiterFulfilledEvents = allEvents.filter((e: any) => e.kind === 'waiter.fulfilled');
    expect(waiterFulfilledEvents.length).toBe(1);
    expect(waiterFulfilledEvents[0].consumed).toBe(1);

    // 1x flow.completed
    const flowCompletedEvents = allEvents.filter((e: any) => e.kind === 'flow.completed');
    expect(flowCompletedEvents.length).toBe(1);
    expect(flowCompletedEvents[0].consumed).toBe(1);
  });
});
