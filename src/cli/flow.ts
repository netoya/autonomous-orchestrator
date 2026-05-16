// Subcomando: orchestrator flow create <name>
// Crea un flow nuevo + una task placeholder.

import { openDb } from '../db/connection.js';
import { createFlow } from '../db/dao/flows.js';
import { createTask } from '../db/dao/tasks.js';
import { ulid } from '../lib/ulid.js';
import { now } from '../lib/clock.js';

export default async function flow(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'create') {
    return flowCreate(args.slice(1));
  }

  console.error(`Unknown flow subcommand: ${subcommand}`);
  process.exit(1);
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
