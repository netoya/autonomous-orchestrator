// DAO para la tabla executions.
// Tracking de ejecuciones de tasks por agentes.

import type Database from 'better-sqlite3';

export interface ExecutionRow {
  id: string;
  task_id: string;
  agent_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  tokens_input: number;
  tokens_output: number;
}

export interface CreateExecutionInput {
  id: string;
  task_id: string;
  agent_id: string;
  started_at: number;
  status: string;
}

export function createExecution(db: Database.Database, input: CreateExecutionInput): ExecutionRow {
  const stmt = db.prepare(`
    INSERT INTO executions (id, task_id, agent_id, started_at, finished_at, status, tokens_input, tokens_output)
    VALUES (?, ?, ?, ?, NULL, ?, 0, 0)
  `);

  stmt.run(input.id, input.task_id, input.agent_id, input.started_at, input.status);

  return findExecutionById(db, input.id)!;
}

export function findExecutionById(db: Database.Database, id: string): ExecutionRow | undefined {
  const stmt = db.prepare('SELECT * FROM executions WHERE id = ?');
  return stmt.get(id) as ExecutionRow | undefined;
}

export function finishExecution(
  db: Database.Database,
  id: string,
  finished_at: number,
  status: string,
  tokens_input: number,
  tokens_output: number
): void {
  const stmt = db.prepare(`
    UPDATE executions
    SET finished_at = ?, status = ?, tokens_input = ?, tokens_output = ?
    WHERE id = ?
  `);

  stmt.run(finished_at, status, tokens_input, tokens_output, id);
}
