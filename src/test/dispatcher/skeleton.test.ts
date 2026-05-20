// Tests del dispatcher esqueleto.
// Smoke test: task ready → done con evento task.finished.
// Waiter pasivo: task queda en waiting-waiter y no se procesa.

// Tests del dispatcher esqueleto.
// Smoke test: task ready → done con evento task.finished.
// Waiter pasivo: task queda en waiting-waiter y no se procesa.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask } from '../../db/dao/tasks.js';
import { createPassiveWaiter } from '../../db/dao/waiters.js';
import { listPendingEvents } from '../../db/dao/events.js';
import { MockAgentRunner } from '../../agent/mock.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import { createTestSchema } from '../helpers/test-schema.js';
import type Database from 'better-sqlite3';

const TEST_DB_PATH = resolve(process.cwd(), 'state/test-dispatcher.db');
const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('Dispatcher skeleton', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Asegurar que existe state/
    if (!existsSync(TEST_STATE_DIR)) {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
    }

    // Limpiar DB de test si existe
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    // Abrir DB y aplicar migraciones manualmente (no podemos llamar al migration runner aqui)
    db = openDb(TEST_DB_PATH);

    // Aplicar schema minimo para tests usando helper
    createTestSchema(db);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it('procesa task ready → done y emite evento task.finished', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    // Crear flow + task ready
    createFlow(db, {
      id: flowId,
      name: 'test-flow',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'test' }),
      idempotency_key: `${flowId}-test`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    // Arrancar dispatcher en modo test (limitado a 3 iteraciones de tick A)
    const dispatcher = new Dispatcher(TEST_DB_PATH);

    // Mock runner seeded para que devuelva success
    // Nota: ahora el dispatcher parsea input_json y extrae 'message', asi que seedeamos con 'test'
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;
    runner.seed('softwarefactory_mateo', 'test', {
      output: 'Task completed',
    });

    await dispatcher.start();

    // Esperar 3 ticks (1.5s aprox) para que procese
    await new Promise((r) => setTimeout(r, 1500));

    await dispatcher.stop();

    // Verificar resultado
    db = openDb(TEST_DB_PATH);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');
    expect(task.output_json).toContain('Task completed');

    // Verificar evento task.finished emitido (puede estar consumed=1 si tick E ya lo proceso)
    const allEvents = db.prepare('SELECT * FROM events ORDER BY id').all() as any[];
    expect(allEvents.length).toBeGreaterThan(0);

    const finishedEvent = allEvents.find((e: any) => e.kind === 'task.finished');
    expect(finishedEvent).toBeDefined();

    const payload = JSON.parse(finishedEvent!.payload_json);
    expect(payload.task_id).toBe(taskId);
    expect(finishedEvent!.consumed).toBe(1); // tick E ya lo consumio
  });

  it('task con waiter pasivo queda en waiting-waiter y no se procesa por selector', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-waiter',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task en waiting-waiter (simulando que tiene un waiter pendiente)
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

    // Waiter pasivo esperando
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

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Esperar ticks
    await new Promise((r) => setTimeout(r, 1500));

    await dispatcher.stop();

    // Verificar que la task sigue en waiting-waiter (no fue procesada)
    db = openDb(TEST_DB_PATH);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('waiting-waiter');

    // No debe haber executions para esta task
    const executions = db.prepare('SELECT * FROM executions WHERE task_id = ?').all(taskId);
    expect(executions.length).toBe(0);
  });

  // FIX #3 (P1): Test para Tick H cleanup de waiters huerfanos
  it('Tick H marca waiter como expired si su task esta en estado terminal (done)', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-tick-h',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task que ya esta done (ej: se marco manualmente, o se completo por otro path)
    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-done',
      agent_id: 'softwarefactory_mateo',
      status: 'done',
      input_json: JSON.stringify({ message: 'already done' }),
      idempotency_key: `${flowId}-test-done`,
      created_at: timestamp - 5000,
      updated_at: timestamp - 1000,
      priority: 1,
    });

    // Waiter pasivo que quedo huerfano (task ya esta done pero waiter sigue en waiting).
    // Usamos kind='clarification' (NO 'approve-text'): los approve-text estan exceptuados
    // del cleanup de huerfanos porque su lifecycle es desacoplado de la task que los creo
    // (ver dispatcher.tickH comment).
    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'orphan-approval',
      kind: 'clarification',
      prompt: 'Aclarar algo',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp - 3000,
      expires_at: timestamp + 60000,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar ejecucion manual de tickH (en lugar de esperar 60s)
    (dispatcher as any).tickH();

    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    db = openDb(TEST_DB_PATH);

    // El waiter debe estar ahora en estado 'timeout' (representa waiters obsoletos/huerfanos)
    const waiter = db.prepare('SELECT * FROM waiters WHERE id = ?').get(waiterId) as any;
    expect(waiter.status).toBe('timeout');
  });

  it('Tick H NO expira waiters si task sigue en estado no-terminal (waiting-waiter)', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-flow-tick-h-valid',
      created_at: timestamp,
      updated_at: timestamp,
    });

    // Task en waiting-waiter (esperando que se cumplan sus waiters)
    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-waiting',
      agent_id: 'softwarefactory_camila',
      status: 'waiting-waiter',
      input_json: JSON.stringify({ message: 'waiting for approval' }),
      idempotency_key: `${flowId}-test-waiting`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    // Waiter pasivo valido
    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'valid-approval',
      kind: 'approve-text',
      prompt: 'Aprobar',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Forzar tickH
    (dispatcher as any).tickH();

    await new Promise((r) => setTimeout(r, 100));

    await dispatcher.stop();

    db = openDb(TEST_DB_PATH);

    // El waiter debe seguir en 'waiting' (NO fue expirado porque task no esta en terminal)
    const waiter = db.prepare('SELECT * FROM waiters WHERE id = ?').get(waiterId) as any;
    expect(waiter.status).toBe('waiting');
  });
});
