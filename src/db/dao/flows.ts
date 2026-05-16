// DAO para la tabla flows.
// CRUD minimo, sin convertir epochs a Date (usamos numbers).

import type Database from 'better-sqlite3';

export interface FlowRow {
  id: string;
  name: string;
  version: string;
  status: 'queued' | 'running' | 'hibernated' | 'completed' | 'failed' | 'cancelled';
  autonomy: string;
  created_at: number;
  updated_at: number;
  budget_json: string;
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
}

export function createFlow(db: Database.Database, input: CreateFlowInput): FlowRow {
  const stmt = db.prepare(`
    INSERT INTO flows (id, name, version, status, autonomy, created_at, updated_at, budget_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    input.id,
    input.name,
    input.version ?? '1.0.0',
    input.status ?? 'queued',
    input.autonomy ?? 'L3',
    input.created_at,
    input.updated_at,
    input.budget_json ?? '{}'
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
