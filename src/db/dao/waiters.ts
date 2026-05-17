// DAO para la tabla waiters.
// Solo lo necesario para waiter pasivo en MVP.

import type Database from 'better-sqlite3';
import { insertEvent } from './events.js';

export interface WaiterRow {
  id: string;
  flow_id: string;
  task_id: string;
  step_id: string;
  mode: 'passive' | 'active';
  kind: string;
  prompt: string;
  schema_json: string;
  authz_json: string;
  timeout_ms: number;
  created_at: number;
  expires_at: number;
  status: 'waiting' | 'fulfilled' | 'rejected' | 'timeout' | 'invalid';
  value_json: string | null;
  attempts: number;
  last_attempt_at: number | null;
  fulfilled_by: string | null;
  fulfilled_at: number | null;

  // Campos activos (NULL para pasivos)
  script_path: string | null;
  script_version: string | null;
  condition_kind: string | null;
  condition_params_json: string | null;
  poll_interval_ms: number;
  poll_schedule_json: string | null;
  poll_max_attempts: number;
  check_count: number;
  consecutive_errors: number;
  last_check_at: number | null;
  last_check_result: string | null;
  next_check_at: number | null;

  horizon: 'short' | 'long';
  max_lifetime_days: number | null;
  context_snapshot_hash: string | null;

  lease_until: number | null;
  lease_holder: string | null;
  last_checked: number | null;
}

export interface CreatePassiveWaiterInput {
  id: string;
  flow_id: string;
  task_id: string;
  step_id: string;
  kind: string;
  prompt: string;
  schema_json: string;
  authz_json?: string;
  timeout_ms: number;
  created_at: number;
  expires_at: number;
}

export function createPassiveWaiter(db: Database.Database, input: CreatePassiveWaiterInput): WaiterRow {
  const stmt = db.prepare(`
    INSERT INTO waiters (
      id, flow_id, task_id, step_id, mode, kind, prompt, schema_json, authz_json,
      timeout_ms, created_at, expires_at, status
    )
    VALUES (?, ?, ?, ?, 'passive', ?, ?, ?, ?, ?, ?, ?, 'waiting')
  `);

  stmt.run(
    input.id,
    input.flow_id,
    input.task_id,
    input.step_id,
    input.kind,
    input.prompt,
    input.schema_json,
    input.authz_json ?? '{}',
    input.timeout_ms,
    input.created_at,
    input.expires_at
  );

  return findWaiterById(db, input.id)!;
}

export function findWaiterById(db: Database.Database, id: string): WaiterRow | undefined {
  const stmt = db.prepare('SELECT * FROM waiters WHERE id = ?');
  return stmt.get(id) as WaiterRow | undefined;
}

export function fulfillWaiter(
  db: Database.Database,
  id: string,
  value_json: string,
  fulfilled_by: string,
  fulfilled_at: number
): void {
  // Leer waiter antes del UPDATE para obtener task_id y flow_id
  const waiter = findWaiterById(db, id);
  if (!waiter) {
    throw new Error(`Waiter ${id} not found`);
  }

  // Transaccion atomica: UPDATE + insertEvent
  db.transaction(() => {
    const updateStmt = db.prepare(`
      UPDATE waiters
      SET status = 'fulfilled', value_json = ?, fulfilled_by = ?, fulfilled_at = ?
      WHERE id = ?
    `);
    updateStmt.run(value_json, fulfilled_by, fulfilled_at, id);

    // Emitir evento waiter.fulfilled
    insertEvent(db, 'waiter.fulfilled', {
      waiter_id: id,
      task_id: waiter.task_id,
      flow_id: waiter.flow_id,
      value: JSON.parse(value_json),
    }, fulfilled_at);
  })();
}

export function findWaitingByFlow(db: Database.Database, flow_id: string): WaiterRow[] {
  const stmt = db.prepare('SELECT * FROM waiters WHERE flow_id = ? AND status = ? ORDER BY created_at');
  return stmt.all(flow_id, 'waiting') as WaiterRow[];
}

export function listPassiveWaitersForTask(db: Database.Database, task_id: string): WaiterRow[] {
  const stmt = db.prepare(`
    SELECT * FROM waiters
    WHERE task_id = ? AND mode = 'passive' AND status = 'waiting'
    ORDER BY created_at
  `);
  return stmt.all(task_id) as WaiterRow[];
}

// ─── Active waiters (kind='exec-command') ─────────────────────────────────

export interface CreateActiveWaiterInput {
  id: string;
  flow_id: string;
  task_id: string;
  step_id: string;
  kind: string;                       // ej: 'exec-command'
  prompt: string;                     // descripcion humana
  condition_kind: string;             // ej: 'exec-command'
  condition_params_json: string;      // {cmd, cwd, timeoutMs}
  timeout_ms: number;
  created_at: number;
  expires_at: number;
}

export function createActiveWaiter(db: Database.Database, input: CreateActiveWaiterInput): WaiterRow {
  const stmt = db.prepare(`
    INSERT INTO waiters (
      id, flow_id, task_id, step_id, mode, kind, prompt, schema_json, authz_json,
      timeout_ms, created_at, expires_at, status,
      condition_kind, condition_params_json
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, '{}', '{}', ?, ?, ?, 'waiting', ?, ?)
  `);
  stmt.run(
    input.id,
    input.flow_id,
    input.task_id,
    input.step_id,
    input.kind,
    input.prompt,
    input.timeout_ms,
    input.created_at,
    input.expires_at,
    input.condition_kind,
    input.condition_params_json,
  );
  return findWaiterById(db, input.id)!;
}

export function listPendingActiveWaiters(db: Database.Database, kind: string): WaiterRow[] {
  const stmt = db.prepare(`
    SELECT * FROM waiters
    WHERE mode = 'active' AND kind = ? AND status = 'waiting'
    ORDER BY created_at
  `);
  return stmt.all(kind) as WaiterRow[];
}
