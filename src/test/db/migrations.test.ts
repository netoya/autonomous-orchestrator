// Smoke tests del bloque de migraciones + schema + DAOs.
// Segun mandato de Mateo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../db/connection.js';
import { sha256 } from '../../lib/sha256.js';
import { ulid } from '../../lib/ulid.js';
import { now } from '../../lib/clock.js';
import { createFlow, findFlowById } from '../../db/dao/flows.js';
import { createTask, markTaskAsDone } from '../../db/dao/tasks.js';
import { listPendingEvents } from '../../db/dao/events.js';
import { findTaskByIdempotencyKey } from '../../db/dao/tasks.js';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.resolve(__dirname, '../../../state/test.db');

beforeEach(() => {
  // Limpiar DB de test antes de cada test
  [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`].forEach(f => {
    if (existsSync(f)) unlinkSync(f);
  });
});

afterEach(() => {
  // Limpiar despues
  [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`].forEach(f => {
    if (existsSync(f)) unlinkSync(f);
  });
});

describe('Migraciones', () => {
  it('Test 1: npm run migrate en DB nueva deja schema_migrations con N filas', () => {
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    const sqlFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

    // Correr migraciones
    execSync(`DB_PATH=${TEST_DB} npm run migrate`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    // Abrir DB y verificar
    const db = openDb(TEST_DB);
    const rows = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    db.close();

    expect(rows.count).toBe(sqlFiles.length);
  });

  it('Test 2: PRAGMA journal_mode retorna wal', () => {
    execSync(`DB_PATH=${TEST_DB} npm run migrate`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    const db = openDb(TEST_DB);
    const result = db.pragma('journal_mode', { simple: true });
    db.close();

    expect(result).toBe('wal');
  });

  it('Test 3: insertar flow + task + completar task dispara evento task.finished', () => {
    execSync(`DB_PATH=${TEST_DB} npm run migrate`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    const db = openDb(TEST_DB);
    const ts = now();

    const flow = createFlow(db, {
      id: ulid(),
      name: 'test-flow',
      created_at: ts,
      updated_at: ts
    });

    const task = createTask(db, {
      id: ulid(),
      flow_id: flow.id,
      stage: 'build',
      agent_id: 'test-agent',
      input_json: '{}',
      idempotency_key: `test-${ulid()}`,
      created_at: ts,
      updated_at: ts
    });

    // Antes de marcar done, no hay eventos
    let events = listPendingEvents(db);
    expect(events.length).toBe(0);

    // Marcar task como done -> dispara trigger
    markTaskAsDone(db, task.id, '{"result":"ok"}', now());

    // Ahora debe haber 1 evento task.finished
    events = listPendingEvents(db);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe('task.finished');

    const payload = JSON.parse(events[0]!.payload_json);
    expect(payload.task_id).toBe(task.id);
    expect(payload.flow_id).toBe(flow.id);

    db.close();
  });

  it('Test 4: idempotency_key duplicado genera constraint violation', () => {
    execSync(`DB_PATH=${TEST_DB} npm run migrate`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    const db = openDb(TEST_DB);
    const ts = now();

    const flow = createFlow(db, {
      id: ulid(),
      name: 'test-flow',
      created_at: ts,
      updated_at: ts
    });

    const idemKey = `test-${ulid()}`;

    createTask(db, {
      id: ulid(),
      flow_id: flow.id,
      stage: 'build',
      agent_id: 'test-agent',
      input_json: '{}',
      idempotency_key: idemKey,
      created_at: ts,
      updated_at: ts
    });

    // Intentar insertar otra task con mismo idempotency_key -> debe fallar
    expect(() => {
      createTask(db, {
        id: ulid(),
        flow_id: flow.id,
        stage: 'build',
        agent_id: 'test-agent',
        input_json: '{}',
        idempotency_key: idemKey,
        created_at: ts,
        updated_at: ts
      });
    }).toThrow();

    db.close();
  });

  it('Test 5: reset en NODE_ENV=test borra y recrea', () => {
    // Primera aplicacion
    execSync(`DB_PATH=${TEST_DB} npm run migrate`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    const db1 = openDb(TEST_DB);
    const flow = createFlow(db1, {
      id: ulid(),
      name: 'test-flow',
      created_at: now(),
      updated_at: now()
    });
    db1.close();

    // Reset
    execSync(`DB_PATH=${TEST_DB} NODE_ENV=test npm run migrate:reset`, { encoding: 'utf-8', cwd: path.resolve(__dirname, '../../..') });

    // Verificar que el flow anterior ya no existe
    const db2 = openDb(TEST_DB);
    const result = findFlowById(db2, flow.id);
    expect(result).toBeUndefined();

    // Pero la DB esta funcional
    const migrations = db2.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(migrations.count).toBeGreaterThan(0);

    db2.close();
  });
});
