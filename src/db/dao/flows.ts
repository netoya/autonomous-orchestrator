// DAO para la tabla flows.
// CRUD minimo, sin convertir epochs a Date (usamos numbers).

import type Database from 'better-sqlite3';
import { insertEvent } from './events.js';
import { cancelWaitersForFlow } from './waiters.js';

export interface FlowRow {
  id: string;
  name: string;
  version: string;
  status: 'queued' | 'running' | 'hibernated' | 'completed' | 'failed' | 'cancelled';
  autonomy: string;
  created_at: number;
  updated_at: number;
  budget_json: string;
  parent_flow_id: string | null;
}

export interface CreateFlowInput {
  id: string;
  name: string;
  version?: string;
  status?: FlowRow['status'];
  autonomy?: string;
  created_at: number;
  updated_at: number;
  budget_json?: string;
  parent_flow_id?: string;
}

export function createFlow(db: Database.Database, input: CreateFlowInput): FlowRow {
  const stmt = db.prepare(`
    INSERT INTO flows (id, name, version, status, autonomy, created_at, updated_at, budget_json, parent_flow_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    input.id,
    input.name,
    input.version ?? '1.0.0',
    input.status ?? 'queued',
    input.autonomy ?? 'L3',
    input.created_at,
    input.updated_at,
    input.budget_json ?? '{}',
    input.parent_flow_id ?? null,
  );

  return findFlowById(db, input.id)!;
}

export function findFlowById(db: Database.Database, id: string): FlowRow | undefined {
  const stmt = db.prepare('SELECT * FROM flows WHERE id = ?');
  return stmt.get(id) as FlowRow | undefined;
}

export function updateFlowStatus(db: Database.Database, id: string, status: FlowRow['status'], updated_at: number): void {
  const stmt = db.prepare('UPDATE flows SET status = ?, updated_at = ? WHERE id = ?');
  stmt.run(status, updated_at, id);
}

export function listFlows(db: Database.Database, limit = 100): FlowRow[] {
  const stmt = db.prepare('SELECT * FROM flows ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit) as FlowRow[];
}

// ADR-006: lifecycle controls.

export interface CancelFlowResult {
  flow_cancelled: boolean;
  cancelled_tasks: string[];
  cancelled_waiters: string[];
  already_terminal: boolean;
}

/**
 * Cancel cascade: flow + tasks no-terminales + waiters waiting → 'cancelled'.
 * Emite `flow.cancelled` con la lista completa.
 * Idempotente: si flow ya está en estado terminal, retorna `already_terminal=true` sin tocar nada.
 *
 * NO mata procesos `claude -p` — eso lo hace el dispatcher al detectar el evento.
 */
export function cancelFlow(
  db: Database.Database,
  flow_id: string,
  opts: { reason?: string; cancelled_at: number },
): CancelFlowResult {
  const flow = findFlowById(db, flow_id);
  if (!flow) {
    throw new Error(`Flow ${flow_id} not found`);
  }

  // Idempotente: si ya está terminal, no-op.
  if (flow.status === 'completed' || flow.status === 'failed' || flow.status === 'cancelled') {
    return {
      flow_cancelled: false,
      cancelled_tasks: [],
      cancelled_waiters: [],
      already_terminal: true,
    };
  }

  const cancelled_at = opts.cancelled_at;
  let cancelled_tasks: string[] = [];
  let cancelled_waiters: string[] = [];

  db.transaction(() => {
    // 1. Listar tasks no-terminales del flow para cancelar.
    const tasks = db
      .prepare(
        `SELECT id FROM tasks
         WHERE flow_id = ?
           AND status IN ('queued','ready','running','waiting-waiter')`,
      )
      .all(flow_id) as Array<{ id: string }>;
    cancelled_tasks = tasks.map((t) => t.id);

    // 2. Cancelar tasks.
    if (cancelled_tasks.length > 0) {
      const stmt = db.prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      );
      for (const id of cancelled_tasks) {
        stmt.run(cancelled_at, id);
      }
    }

    // 3. Cancelar waiters waiting del flow.
    cancelled_waiters = cancelWaitersForFlow(db, flow_id, cancelled_at);

    // 4. Marcar flow como cancelled.
    updateFlowStatus(db, flow_id, 'cancelled', cancelled_at);

    // 5. Emitir evento flow.cancelled.
    insertEvent(
      db,
      'flow.cancelled',
      {
        flow_id,
        reason: opts.reason ?? null,
        cancelled_tasks,
        cancelled_waiters,
      },
      cancelled_at,
    );
  })();

  return {
    flow_cancelled: true,
    cancelled_tasks,
    cancelled_waiters,
    already_terminal: false,
  };
}
