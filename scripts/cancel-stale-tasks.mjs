#!/usr/bin/env node
// Cancela tasks pre-existentes (queued/failed/running) excepto la task objetivo.
// Tambien cancela waiters activos asociados a flows viejos.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const keepTaskId = process.argv[2];
if (!keepTaskId) {
  console.error('Usage: cancel-stale-tasks.mjs <taskIdToKeep>');
  process.exit(1);
}

const dbPath = resolve(process.cwd(), 'state/orchestrator.db');
const db = new Database(dbPath);
const ts = Date.now();

const keepRow = db.prepare('SELECT flow_id FROM tasks WHERE id = ?').get(keepTaskId);
if (!keepRow) {
  console.error(`Task ${keepTaskId} not found`);
  process.exit(1);
}
const keepFlowId = keepRow.flow_id;
console.log(`Keep task=${keepTaskId} flow=${keepFlowId}`);

const taskRes = db
  .prepare(
    `UPDATE tasks SET status = 'cancelled', updated_at = ?
     WHERE id != ? AND status IN ('queued','failed','running','ready','waiting-waiter')`,
  )
  .run(ts, keepTaskId);
console.log(`Cancelled tasks: ${taskRes.changes}`);

const waiterRes = db
  .prepare(
    `UPDATE waiters SET status = 'rejected' WHERE status = 'waiting' AND flow_id != ?`,
  )
  .run(keepFlowId);
console.log(`Cancelled waiters: ${waiterRes.changes}`);

const flowRes = db
  .prepare(
    `UPDATE flows SET status = 'cancelled', updated_at = ?
     WHERE id != ? AND status IN ('queued','running')`,
  )
  .run(ts, keepFlowId);
console.log(`Cancelled flows: ${flowRes.changes}`);

db.close();
