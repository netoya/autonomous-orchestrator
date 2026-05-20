// Subcomando: orchestrator waiter list | fulfill <id> --json '{...}' | reject <id> --reason "..."
// Manejo de waiters pasivos.

import { openDb } from '../db/connection.js';
import { fulfillWaiter, rejectWaiter, type WaiterRow } from '../db/dao/waiters.js';
import { now } from '../lib/clock.js';

export default async function waiter(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    return waiterList(args.slice(1));
  }

  if (subcommand === 'fulfill') {
    return waiterFulfill(args.slice(1));
  }

  if (subcommand === 'reject') {
    return waiterReject(args.slice(1));
  }

  console.error(`Unknown waiter subcommand: ${subcommand}`);
  console.error(`Usage: orchestrator waiter list [--pending]`);
  console.error(`       orchestrator waiter fulfill <id> --json '{...}'`);
  console.error(`       orchestrator waiter reject <id> --reason "..."`);
  process.exit(1);
}

async function waiterReject(args: string[]): Promise<void> {
  const waiterId = args[0];
  if (!waiterId) {
    console.error('Usage: orchestrator waiter reject <id> --reason "..."');
    process.exit(1);
  }

  // Parsear --reason (obligatorio)
  let reason: string | undefined;
  const reasonIdx = args.findIndex((a) => a === '--reason');
  if (reasonIdx >= 0) {
    reason = args[reasonIdx + 1];
  }

  if (!reason || reason.trim().length === 0) {
    console.error('Error: --reason is required and cannot be empty');
    process.exit(1);
  }

  const db = openDb();
  try {
    const result = rejectWaiter(db, waiterId, reason, 'cli-operator', now());

    if (!result) {
      console.log(`Waiter ${waiterId} is already in a terminal state — no-op.`);
      process.exit(0);
    }

    console.log(`Waiter ${waiterId} rejected.`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Task ${result.task_id} will be transitioned to cancelled by dispatcher.`);
  } finally {
    db.close();
  }
}

async function waiterList(args: string[]): Promise<void> {
  const db = openDb();

  // Parsear --pending
  const pendingOnly = args.includes('--pending');

  let query = 'SELECT * FROM waiters';
  if (pendingOnly) {
    query += " WHERE status = 'waiting'";
  }
  query += ' ORDER BY created_at DESC LIMIT 50';

  const waiters = db.prepare(query).all() as WaiterRow[];

  if (waiters.length === 0) {
    console.log('No waiters found');
    db.close();
    return;
  }

  console.log(
    'ID                           | Flow ID                      | Task ID                      | Kind             | Status    | Mode    ',
  );
  console.log(
    '-----------------------------------------------------------------------------------------------------------------------',
  );

  for (const w of waiters) {
    const id = w.id.slice(0, 26).padEnd(26);
    const flowId = w.flow_id.slice(0, 26).padEnd(26);
    const taskId = w.task_id.slice(0, 26).padEnd(26);
    const kind = w.kind.slice(0, 16).padEnd(16);
    const status = w.status.padEnd(9);
    const mode = w.mode.padEnd(8);

    console.log(`${id} | ${flowId} | ${taskId} | ${kind} | ${status} | ${mode}`);
  }

  db.close();
}

async function waiterFulfill(args: string[]): Promise<void> {
  const waiterId = args[0];

  if (!waiterId) {
    console.error('Usage: orchestrator waiter fulfill <id> --json <json>');
    process.exit(1);
  }

  // Parsear --json
  let jsonArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && args[i + 1]) {
      jsonArg = args[i + 1] ?? null;
      break;
    }
  }

  if (!jsonArg) {
    console.error('Missing --json argument');
    process.exit(1);
  }

  let valueJson: string;
  try {
    // Validar que sea JSON valido
    const parsed = JSON.parse(jsonArg);
    valueJson = JSON.stringify(parsed);
  } catch {
    console.error('Invalid JSON');
    process.exit(1);
  }

  const db = openDb();
  const timestamp = now();

  // Fulfill waiter (emite evento waiter.fulfilled en transaccion atomica)
  fulfillWaiter(db, waiterId, valueJson, 'cli-operator', timestamp);

  console.log(`Waiter ${waiterId} fulfilled`);

  db.close();
}
