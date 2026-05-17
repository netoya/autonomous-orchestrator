// Subcomando: orchestrator coordinate "<idea>"
// Crea un flow nuevo + una task coordinator seed que planifica la idea.

import { openDb } from '../db/connection.js';
import { createFlow } from '../db/dao/flows.js';
import { createTask } from '../db/dao/tasks.js';
import { ulid } from '../lib/ulid.js';
import { now } from '../lib/clock.js';

export default async function coordinate(args: string[]): Promise<void> {
  const idea = args[0];

  if (!idea) {
    console.error('Usage: orchestrator coordinate "<idea>"');
    process.exit(1);
  }

  const db = openDb();

  const flowId = ulid();
  const taskId = ulid();
  const timestamp = now();

  // Generar nombre del flow (slug de primeras 5 palabras)
  const words = idea.split(/\s+/).filter((w) => w.length > 0);
  const slug = words
    .slice(0, 5)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const flowName = slug || 'coordinate-flow';

  // Crear flow
  const flowRow = createFlow(db, {
    id: flowId,
    name: flowName,
    status: 'queued',
    autonomy: 'L3',
    created_at: timestamp,
    updated_at: timestamp,
  });

  // Crear task coordinator seed
  const taskRow = createTask(db, {
    id: taskId,
    flow_id: flowId,
    stage: 'coordinate',
    agent_id: 'softwarefactory_coordinator',
    status: 'ready',
    input_json: JSON.stringify({
      message: idea,
      permission_mode: 'acceptEdits',
      max_turns: 60,
    }),
    idempotency_key: `${flowId}-coordinate`,
    created_at: timestamp,
    updated_at: timestamp,
    priority: 10,
  });

  console.log(`Flow created: ${flowRow.id}`);
  console.log(`Coordinator task: ${taskRow.id}`);

  db.close();
}
