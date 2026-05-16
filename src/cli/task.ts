// Subcomando: orchestrator task list [--status=X]
// Lista tasks con filtro opcional por status.

import { openDb } from '../db/connection.js';
import type { TaskRow } from '../db/dao/tasks.js';

export default async function task(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    return taskList(args.slice(1));
  }

  console.error(`Unknown task subcommand: ${subcommand}`);
  process.exit(1);
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
