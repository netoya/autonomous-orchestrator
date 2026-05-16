// Flow de ejemplo: hello-world-with-approval
// Demuestra uso de waiter pasivo entre tasks.
// NO se ejecuta automaticamente (no hay sprint loader todavia).

import { ulid } from '../lib/ulid.js';
import { now } from '../lib/clock.js';
import type Database from 'better-sqlite3';
import { createFlow } from '../db/dao/flows.js';
import { createTask } from '../db/dao/tasks.js';
import { createPassiveWaiter } from '../db/dao/waiters.js';

export interface HelloWorldFlowConfig {
  db: Database.Database;
  flowName?: string;
}

/**
 * Crea un flow con 3 tasks:
 * 1. task-a-greet: saluda (agente Camila)
 * 2. task-b-approve: espera aprobacion humana via waiter pasivo
 * 3. task-c-finalize: confirma (agente Camila)
 */
export function createHelloWorldFlow(config: HelloWorldFlowConfig): string {
  const { db, flowName = 'hello-world-with-approval' } = config;

  const flowId = ulid();
  const timestamp = now();

  // Crear flow
  createFlow(db, {
    id: flowId,
    name: flowName,
    status: 'queued',
    autonomy: 'L3',
    created_at: timestamp,
    updated_at: timestamp,
  });

  // Task A: greet
  const taskAId = ulid();
  createTask(db, {
    id: taskAId,
    flow_id: flowId,
    stage: 'greet',
    agent_id: 'softwarefactory_camila',
    status: 'ready',
    input_json: JSON.stringify({ message: 'Di hola al usuario' }),
    idempotency_key: `${flowId}-greet`,
    created_at: timestamp,
    updated_at: timestamp,
    priority: 5,
  });

  // Task B: approve (con waiter pasivo)
  const taskBId = ulid();
  const waiterId = ulid();

  createTask(db, {
    id: taskBId,
    flow_id: flowId,
    stage: 'approve',
    agent_id: 'softwarefactory_camila',
    status: 'queued', // esperara a que task-a termine
    input_json: JSON.stringify({ message: 'Esperando aprobacion humana' }),
    idempotency_key: `${flowId}-approve`,
    created_at: timestamp,
    updated_at: timestamp,
    priority: 5,
  });

  // Waiter pasivo para task B
  createPassiveWaiter(db, {
    id: waiterId,
    flow_id: flowId,
    task_id: taskBId,
    step_id: 'approval-gate',
    kind: 'approve-text',
    prompt: 'Aprobar o rechazar el saludo',
    schema_json: JSON.stringify({
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        comments: { type: 'string' },
        reviewed_by: { type: 'string' },
      },
      required: ['decision', 'reviewed_by'],
    }),
    timeout_ms: 3600_000, // 1 hora
    created_at: timestamp,
    expires_at: timestamp + 3600_000,
  });

  // Task C: finalize
  const taskCId = ulid();
  createTask(db, {
    id: taskCId,
    flow_id: flowId,
    stage: 'finalize',
    agent_id: 'softwarefactory_camila',
    status: 'queued',
    input_json: JSON.stringify({ message: 'Confirmar finalizacion del flow' }),
    idempotency_key: `${flowId}-finalize`,
    created_at: timestamp,
    updated_at: timestamp,
    priority: 5,
  });

  // Dependencias: A -> B -> C
  const depStmt = db.prepare(`
    INSERT INTO task_dependencies (task_id, depends_on_task_id, kind, created_at)
    VALUES (?, ?, 'finish-to-start', ?)
  `);

  depStmt.run(taskBId, taskAId, timestamp); // B depende de A
  depStmt.run(taskCId, taskBId, timestamp); // C depende de B

  return flowId;
}
