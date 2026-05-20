// Subcomando: orchestrator flow create <name> | flow cancel <id> [--reason "..."]

import { openDb } from '../db/connection.js';
import { createFlow, cancelFlow } from '../db/dao/flows.js';
import { createTask } from '../db/dao/tasks.js';
import { ulid } from '../lib/ulid.js';
import { now } from '../lib/clock.js';

export default async function flow(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'create') {
    return flowCreate(args.slice(1));
  }

  if (subcommand === 'cancel') {
    return flowCancel(args.slice(1));
  }

  console.error(`Unknown flow subcommand: ${subcommand}`);
  console.error(`Usage: orchestrator flow create <name>`);
  console.error(`       orchestrator flow cancel <flow-id> [--reason "..."]`);
  process.exit(1);
}

async function flowCancel(args: string[]): Promise<void> {
  const flowId = args[0];
  if (!flowId) {
    console.error('Usage: orchestrator flow cancel <flow-id> [--reason "..."]');
    process.exit(1);
  }

  // Parsear --reason
  let reason: string | undefined;
  const reasonIdx = args.findIndex((a) => a === '--reason');
  if (reasonIdx >= 0) {
    reason = args[reasonIdx + 1];
  }

  const db = openDb();
  try {
    const result = cancelFlow(db, flowId, { reason, cancelled_at: now() });

    if (result.already_terminal) {
      console.log(`Flow ${flowId} is already in a terminal state — no-op.`);
      process.exit(0);
    }

    console.log(`Flow ${flowId} cancelled.`);
    console.log(`  Reason: ${reason ?? '(none)'}`);
    console.log(`  Tasks cancelled: ${result.cancelled_tasks.length}`);
    console.log(`  Waiters cancelled: ${result.cancelled_waiters.length}`);
  } finally {
    db.close();
  }
}

async function flowCreate(args: string[]): Promise<void> {
  const name = args[0];

  if (!name) {
    console.error('Usage: orchestrator flow create <name>');
    process.exit(1);
  }

  const db = openDb();

  const flowId = ulid();
  const taskId = ulid();
  const timestamp = now();

  // Crear flow
  const flowRow = createFlow(db, {
    id: flowId,
    name,
    status: 'queued',
    autonomy: 'L3',
    created_at: timestamp,
    updated_at: timestamp,
  });

  // Crear task placeholder
  const taskRow = createTask(db, {
    id: taskId,
    flow_id: flowId,
    stage: 'init',
    agent_id: 'softwarefactory_mateo',
    status: 'ready',
    input_json: JSON.stringify({ message: 'Decir hola desde el agente' }),
    idempotency_key: `${flowId}-init`,
    created_at: timestamp,
    updated_at: timestamp,
    priority: 1,
  });

  console.log(`Flow created: ${flowRow.id}`);
  console.log(`Task created: ${taskRow.id} (status=${taskRow.status})`);

  db.close();
}
