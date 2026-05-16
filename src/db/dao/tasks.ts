// DAO para la tabla tasks.
// Incluye markTaskAsDone que dispara el trigger tasks_done_trigger.

import type Database from 'better-sqlite3';

export interface TaskRow {
  id: string;
  flow_id: string;
  parent_task_id: string | null;
  stage: string;
  agent_id: string;
  status: 'queued' | 'ready' | 'running' | 'waiting-waiter' | 'done' | 'failed' | 'cancelled';
  input_json: string;
  output_json: string | null;
  retries: number;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
  error: string | null;
  priority: number;
  business_value: number | null;
  estimated_minutes: number | null;
  tags_json: string;
  is_milestone: number;
}

export interface CreateTaskInput {
  id: string;
  flow_id: string;
  parent_task_id?: string | null;
  stage: string;
  agent_id: string;
  status?: TaskRow['status'];
  input_json: string;
  output_json?: string | null;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
  priority?: number;
  business_value?: number | null;
  estimated_minutes?: number | null;
  tags_json?: string;
  is_milestone?: number;
}

export function createTask(db: Database.Database, input: CreateTaskInput): TaskRow {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, flow_id, parent_task_id, stage, agent_id, status, input_json, output_json,
      retries, idempotency_key, created_at, updated_at, priority, business_value,
      estimated_minutes, tags_json, is_milestone
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    input.id,
    input.flow_id,
    input.parent_task_id ?? null,
    input.stage,
    input.agent_id,
    input.status ?? 'queued',
    input.input_json,
    input.output_json ?? null,
    input.idempotency_key,
    input.created_at,
    input.updated_at,
    input.priority ?? 0,
    input.business_value ?? null,
    input.estimated_minutes ?? null,
    input.tags_json ?? '[]',
    input.is_milestone ?? 0
  );

  return findTaskById(db, input.id)!;
}

export function findTaskById(db: Database.Database, id: string): TaskRow | undefined {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  return stmt.get(id) as TaskRow | undefined;
}

export function findTaskByIdempotencyKey(db: Database.Database, key: string): TaskRow | undefined {
  const stmt = db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?');
  return stmt.get(key) as TaskRow | undefined;
}

export function updateTaskStatus(
  db: Database.Database,
  id: string,
  status: TaskRow['status'],
  updated_at: number,
  error?: string | null
): void {
  const stmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ?, error = ? WHERE id = ?');
  stmt.run(status, updated_at, error ?? null, id);
}

export function markTaskAsDone(
  db: Database.Database,
  id: string,
  output_json: string,
  updated_at: number
): void {
  // Marcar como done dispara tasks_done_trigger que inserta en events
  const stmt = db.prepare('UPDATE tasks SET status = ?, output_json = ?, updated_at = ? WHERE id = ?');
  stmt.run('done', output_json, updated_at, id);
}

export function listTasksByFlow(db: Database.Database, flow_id: string): TaskRow[] {
  const stmt = db.prepare('SELECT * FROM tasks WHERE flow_id = ? ORDER BY created_at');
  return stmt.all(flow_id) as TaskRow[];
}
