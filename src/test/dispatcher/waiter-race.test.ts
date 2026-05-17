// Test de race condition en handleWaiterFulfilled.
// Valida que si una task ya esta en estado terminal (done, cancelled, failed),
// el fulfill del waiter NO la regresa a ready.
// Este es un test de regresion del fix que Mateo hizo en handleWaiterFulfilled.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask, updateTaskStatus, markTaskAsDone } from '../../db/dao/tasks.js';
import { createPassiveWaiter, fulfillWaiter } from '../../db/dao/waiters.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import type Database from 'better-sqlite3';

const TEST_DB_PATH = resolve(process.cwd(), 'state/test-waiter-race.db');
const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('Race condition en handleWaiterFulfilled', () => {
  let db: Database.Database;
  let consoleSpy: any;

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
        idempotency_key TEXT NOT NULL UNIQUE,
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

      CREATE TRIGGER waiter_fulfilled_trigger
      AFTER UPDATE OF status ON waiters
      WHEN NEW.status = 'fulfilled' AND OLD.status <> 'fulfilled'
      BEGIN
        INSERT INTO events(ts, kind, payload_json)
        VALUES (
          strftime('%s','now')*1000,
          'waiter.fulfilled',
          json_object(
            'waiter_id', NEW.id,
            'task_id', NEW.task_id,
            'flow_id', NEW.flow_id
          )
        );
      END;

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

    // Spy en console.log para capturar logs del dispatcher
    consoleSpy = vi.spyOn(console, 'log');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (db) {
      db.close();
    }
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it('NO transiciona task a ready si ya esta done cuando waiter se fulfill', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    // Crear flow + task en waiting-waiter
    createFlow(db, {
      id: flowId,
      name: 'test-race-flow',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-race-task',
      agent_id: 'softwarefactory_mateo',
      status: 'waiting-waiter',
      input_json: JSON.stringify({ message: 'test' }),
      idempotency_key: `${flowId}-test-race`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    // Crear waiter pasivo
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

    // Marcar la task como 'done' manualmente (simulando que algo la marco antes del fulfill)
    markTaskAsDone(db, taskId, JSON.stringify({ result: 'completed' }), timestamp + 100);

    db.close();

    // Arrancar dispatcher
    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    // Esperar un poco para que el dispatcher se inicialice
    await new Promise((r) => setTimeout(r, 500));

    // Fulfillar el waiter DESPUES de que la task ya esta done
    db = openDb(TEST_DB_PATH);
    fulfillWaiter(db, waiterId, JSON.stringify({ approved: true }), 'human', timestamp + 200);
    db.close();

    // Esperar a que Tick E procese el evento waiter.fulfilled
    await new Promise((r) => setTimeout(r, 1000));

    await dispatcher.stop();

    // Verificar que la task sigue en 'done' (NO regreso a ready)
    db = openDb(TEST_DB_PATH);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    // Verificar que el log contiene el mensaje esperado
    const logCalls = consoleSpy.mock.calls.map((call: any[]) => call.join(' '));
    const relevantLog = logCalls.find((log: string) =>
      log.includes(`Waiter fulfilled for task ${taskId}`) && log.includes('already done'),
    );

    expect(relevantLog).toBeDefined();
    expect(relevantLog).toMatch(/already done.*no transition/i);
  });

  it('NO transiciona task a ready si ya esta failed cuando waiter se fulfill', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-race-failed',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-failed-task',
      agent_id: 'softwarefactory_valeria',
      status: 'waiting-waiter',
      input_json: JSON.stringify({ message: 'test' }),
      idempotency_key: `${flowId}-test-failed`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'approval-2',
      kind: 'approve-text',
      prompt: 'Aprobar test failed',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    // Marcar la task como 'failed' manualmente
    updateTaskStatus(db, taskId, 'failed', timestamp + 100, 'Manual failure for test');

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    await new Promise((r) => setTimeout(r, 500));

    db = openDb(TEST_DB_PATH);
    fulfillWaiter(db, waiterId, JSON.stringify({ approved: false }), 'human', timestamp + 200);
    db.close();

    await new Promise((r) => setTimeout(r, 1000));

    await dispatcher.stop();

    // Verificar que la task sigue en 'failed'
    db = openDb(TEST_DB_PATH);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('failed');

    // Verificar log
    const logCalls = consoleSpy.mock.calls.map((call: any[]) => call.join(' '));
    const relevantLog = logCalls.find((log: string) =>
      log.includes(`Waiter fulfilled for task ${taskId}`) && log.includes('already failed'),
    );

    expect(relevantLog).toBeDefined();
  });

  it('NO transiciona task a ready si ya esta cancelled cuando waiter se fulfill', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const waiterId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-race-cancelled',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-cancelled-task',
      agent_id: 'softwarefactory_dante',
      status: 'waiting-waiter',
      input_json: JSON.stringify({ message: 'test' }),
      idempotency_key: `${flowId}-test-cancelled`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    createPassiveWaiter(db, {
      id: waiterId,
      flow_id: flowId,
      task_id: taskId,
      step_id: 'approval-3',
      kind: 'approve-text',
      prompt: 'Aprobar test cancelled',
      schema_json: '{}',
      timeout_ms: 60000,
      created_at: timestamp,
      expires_at: timestamp + 60000,
    });

    // Marcar la task como 'cancelled'
    updateTaskStatus(db, taskId, 'cancelled', timestamp + 100);

    db.close();

    const dispatcher = new Dispatcher(TEST_DB_PATH);
    await dispatcher.start();

    await new Promise((r) => setTimeout(r, 500));

    db = openDb(TEST_DB_PATH);
    fulfillWaiter(db, waiterId, JSON.stringify({ cancelled: true }), 'system', timestamp + 200);
    db.close();

    await new Promise((r) => setTimeout(r, 1000));

    await dispatcher.stop();

    // Verificar que la task sigue en 'cancelled'
    db = openDb(TEST_DB_PATH);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('cancelled');

    // Verificar log
    const logCalls = consoleSpy.mock.calls.map((call: any[]) => call.join(' '));
    const relevantLog = logCalls.find((log: string) =>
      log.includes(`Waiter fulfilled for task ${taskId}`) && log.includes('already cancelled'),
    );

    expect(relevantLog).toBeDefined();
  });
});
