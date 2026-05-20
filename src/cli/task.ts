// Subcomando: orchestrator task list [--status=X] | task waiters <id> [--status <s>] [--json]

import { openDb } from '../db/connection.js';
import { findTaskById, type TaskRow } from '../db/dao/tasks.js';
import { listWaitersForTask } from '../db/dao/waiters.js';

export default async function task(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    return taskList(args.slice(1));
  }

  if (subcommand === 'waiters') {
    return taskWaiters(args.slice(1));
  }

  console.error(`Unknown task subcommand: ${subcommand}`);
  console.error(`Usage: orchestrator task list [--status=X]`);
  console.error(`       orchestrator task waiters <task-id> [--status <s>] [--json]`);
  process.exit(1);
}

async function taskWaiters(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    console.error('Usage: orchestrator task waiters <task-id> [--status <s>] [--json]');
    process.exit(1);
  }

  // Parsear --status (multi) y --json
  const statusFilters: string[] = [];
  let asJson = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') asJson = true;
    if (args[i] === '--status' && args[i + 1]) {
      statusFilters.push(args[i + 1]!);
      i++;
    }
  }

  const db = openDb();
  try {
    const found = findTaskById(db, taskId);
    if (!found) {
      console.error(`Task ${taskId} not found`);
      process.exit(1);
    }

    let waiters = listWaitersForTask(db, taskId);
    if (statusFilters.length > 0) {
      waiters = waiters.filter((w) => statusFilters.includes(w.status));
    }

    if (asJson) {
      console.log(JSON.stringify(waiters, null, 2));
      return;
    }

    if (waiters.length === 0) {
      console.log(`no waiters for task ${taskId}`);
      return;
    }

    console.log(
      'STEP_ID                | KIND             | MODE    | STATUS     | CREATED             | VALUE (truncated)',
    );
    console.log(
      '------------------------------------------------------------------------------------------------------------',
    );
    for (const w of waiters) {
      const step = w.step_id.slice(0, 22).padEnd(22);
      const kind = w.kind.slice(0, 16).padEnd(16);
      const mode = w.mode.padEnd(7);
      const status = w.status.padEnd(10);
      const created = new Date(w.created_at).toISOString().slice(0, 19);
      const valueShort = (w.value_json ?? '').slice(0, 40);
      console.log(`${step} | ${kind} | ${mode} | ${status} | ${created} | ${valueShort}`);
    }
  } finally {
    db.close();
  }
}

async function taskList(args: string[]): Promise<void> {
  const db = openDb();

  // Parsear --status=X
  let statusFilter: string | null = null;
  for (const arg of args) {
    if (arg.startsWith('--status=')) {
      statusFilter = arg.split('=')[1] ?? null;
    }
  }

  let query = 'SELECT * FROM tasks';
  const params: string[] = [];

  if (statusFilter) {
    query += ' WHERE status = ?';
    params.push(statusFilter);
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const stmt = db.prepare(query);
  const tasks = stmt.all(...params) as TaskRow[];

  if (tasks.length === 0) {
    console.log('No tasks found');
    db.close();
    return;
  }

  // Tabla simple
  console.log(
    'ID                           | Stage      | Agent                    | Status          | Priority | Created',
  );
  console.log(
    '-----------------------------------------------------------------------------------------',
  );

  for (const t of tasks) {
    const id = t.id.slice(0, 26).padEnd(26);
    const stage = t.stage.slice(0, 10).padEnd(10);
    const agent = t.agent_id.slice(0, 24).padEnd(24);
    const status = t.status.padEnd(15);
    const priority = String(t.priority).padStart(8);
    const created = new Date(t.created_at).toISOString().slice(0, 16);

    console.log(`${id} | ${stage} | ${agent} | ${status} | ${priority} | ${created}`);
  }

  db.close();
}
