// Test de validateTaskArtifacts: detecta falsos positivos en success=true pero con output de error.
// Valida que el dispatcher loguea WARNING cuando una task se marca como done pero el output
// contiene indicadores de fallo (ej: "permission denied", "no pude", "could not").
// Este test es de regresion para el patron de `claude-exit-1 cosmetico`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { Dispatcher } from '../../dispatcher.js';
import { createFlow } from '../../db/dao/flows.js';
import { createTask } from '../../db/dao/tasks.js';
import { MockAgentRunner } from '../../agent/mock.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import { createTestSchema } from '../helpers/test-schema.js';
import type Database from 'better-sqlite3';

const TEST_STATE_DIR = resolve(process.cwd(), 'state');

describe('validateTaskArtifacts detecta fallos cosmeticos', () => {
  let db: Database.Database;
  let consoleSpy: any;
  let consoleWarnSpy: any;
  let testDbPath: string;

  beforeEach(async () => {
    if (!existsSync(TEST_STATE_DIR)) {
      mkdirSync(TEST_STATE_DIR, { recursive: true });
    }

    // Generar nombre unico para cada test
    testDbPath = resolve(TEST_STATE_DIR, `test-validate-${ulid()}.db`);

    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    db = openDb(testDbPath);

    createTestSchema(db);

    consoleSpy = vi.spyOn(console, 'log');
    consoleWarnSpy = vi.spyOn(console, 'warn');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    if (db) {
      db.close();
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it('detecta "permission denied" en output y loguea WARNING', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-flow',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-validate',
      agent_id: 'softwarefactory_mateo',
      status: 'ready',
      input_json: JSON.stringify({ message: 'write file' }),
      idempotency_key: `${flowId}-test-validate`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    // Seedear respuesta con success=true PERO con output que indica fallo
    runner.seed('softwarefactory_mateo', 'write file', {
      success: true,
      output: 'Lo intente pero no pude escribir el archivo: permission denied',
    });

    await dispatcher.start();

    // Esperar ticks para que procese
    await new Promise((r) => setTimeout(r, 1500));

    await dispatcher.stop();

    // Verificar que la task quedo en 'done' (porque success=true)
    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    // Verificar que se logueo WARNING
    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed') && log.includes('permission denied'),
    );

    expect(warningLog).toBeDefined();
    expect(warningLog).toMatch(/may have not completed.*permission denied/i);
  });

  it('detecta "no pude" en output y loguea WARNING', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-nopude',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-nopude',
      agent_id: 'softwarefactory_valeria',
      status: 'ready',
      input_json: JSON.stringify({ message: 'create component' }),
      idempotency_key: `${flowId}-test-nopude`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    runner.seed('softwarefactory_valeria', 'create component', {
      success: true,
      output: 'Intente crear el componente pero no pude porque el directorio no existe',
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed') && log.includes('no pude'),
    );

    expect(warningLog).toBeDefined();
  });

  it('detecta "could not" en output y loguea WARNING', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-couldnot',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-couldnot',
      agent_id: 'softwarefactory_dante',
      status: 'ready',
      input_json: JSON.stringify({ message: 'deploy service' }),
      idempotency_key: `${flowId}-test-couldnot`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    runner.seed('softwarefactory_dante', 'deploy service', {
      success: true,
      output: 'Deployment attempted but could not connect to server',
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed') && log.includes('could not'),
    );

    expect(warningLog).toBeDefined();
  });

  it('detecta "max_turns_reached" en output y loguea WARNING', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-maxturns',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-maxturns',
      agent_id: 'softwarefactory_coordinator',
      status: 'ready',
      input_json: JSON.stringify({ message: 'coordinate recovery' }),
      idempotency_key: `${flowId}-test-maxturns`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    runner.seed('softwarefactory_coordinator', 'coordinate recovery', {
      success: true,
      output: 'Analysis incomplete: max_turns_reached without creating waiter',
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed') && log.includes('max_turns_reached'),
    );

    expect(warningLog).toBeDefined();
  });

  it('NO loguea WARNING si el output es exitoso sin indicadores de fallo', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-success',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-success',
      agent_id: 'softwarefactory_sofia',
      status: 'ready',
      input_json: JSON.stringify({ message: 'run tests' }),
      idempotency_key: `${flowId}-test-success`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    runner.seed('softwarefactory_sofia', 'run tests', {
      success: true,
      output: 'All tests passed successfully. 19 tests green.',
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    // NO debe haber WARNING para esta task
    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed'),
    );

    expect(warningLog).toBeUndefined();
  });

  it('detecta "unable to" en output y loguea WARNING', async () => {
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    createFlow(db, {
      id: flowId,
      name: 'test-validate-unableto',
      created_at: timestamp,
      updated_at: timestamp,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'test-unableto',
      agent_id: 'softwarefactory_lucas',
      status: 'ready',
      input_json: JSON.stringify({ message: 'generate mockup' }),
      idempotency_key: `${flowId}-test-unableto`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 1,
    });

    db.close();

    const dispatcher = new Dispatcher(testDbPath);
    const runner = (dispatcher as any).agentRunner as MockAgentRunner;

    runner.seed('softwarefactory_lucas', 'generate mockup', {
      success: true,
      output: 'Design process started but unable to access Figma templates',
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 1500));
    await dispatcher.stop();

    db = openDb(testDbPath);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.status).toBe('done');

    const warnCalls = consoleWarnSpy.mock.calls.map((call: any[]) => call.join(' '));
    const warningLog = warnCalls.find((log: string) =>
      log.includes(`Task ${taskId}`) && log.includes('may have not completed') && log.includes('unable to'),
    );

    expect(warningLog).toBeDefined();
  });
});
