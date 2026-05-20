// Subcomando: orchestrator flow create <name> | flow cancel <id> [--reason "..."]
//             | flow confirm <prepareFlowId> [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { openDb } from '../db/connection.js';
import { createFlow, cancelFlow, findFlowById } from '../db/dao/flows.js';
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

  if (subcommand === 'confirm') {
    return flowConfirm(args.slice(1));
  }

  console.error(`Unknown flow subcommand: ${subcommand}`);
  console.error(`Usage: orchestrator flow create <name>`);
  console.error(`       orchestrator flow cancel <flow-id> [--reason "..."]`);
  console.error(`       orchestrator flow confirm <prepare-flow-id> [--dry-run]`);
  process.exit(1);
}

// ADR-007: flow confirm <prepareFlowId>
async function flowConfirm(args: string[]): Promise<void> {
  const prepareFlowId = args[0];
  if (!prepareFlowId) {
    console.error('Usage: orchestrator flow confirm <prepare-flow-id> [--dry-run]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');

  const db = openDb();
  try {
    // 1. Validar prepare flow.
    const prepare = findFlowById(db, prepareFlowId);
    if (!prepare) {
      console.error(`Prepare flow ${prepareFlowId} not found`);
      process.exit(1);
    }
    if (prepare.status !== 'completed') {
      console.error(
        `Prepare flow ${prepareFlowId} is in '${prepare.status}', expected 'completed'`,
      );
      console.error(`(A plan can only be confirmed once its planner flow has reached terminal state.)`);
      process.exit(1);
    }

    // 2. Buscar archivo del plan: primero con flowId, fallback legacy.
    const stateDir = process.env.STATE_DIR ?? 'state';
    const newPath = resolvePath(stateDir, 'conversations', `PLAN-FINAL-${prepareFlowId}.md`);
    const legacyPath = resolvePath(stateDir, 'conversations', 'PLAN-FINAL.md');
    let planPath: string | null = null;
    if (existsSync(newPath)) planPath = newPath;
    else if (existsSync(legacyPath)) planPath = legacyPath;

    if (!planPath) {
      console.error(`No plan file found.`);
      console.error(`  Looked in: ${newPath}`);
      console.error(`  Fallback : ${legacyPath}`);
      process.exit(1);
    }

    // 3. Validar PLAN_READY (regex case-insensitive, primeras 5KB).
    // Acepta variantes markdown: `**Status:** PLAN_READY`, `**Status:** ` + "`PLAN_READY`", etc.
    const planContent = readFileSync(planPath, 'utf8').slice(0, 5000);
    if (!/Status:\s*\**\s*[`'"]?PLAN_READY/i.test(planContent)) {
      console.error(`Plan ${planPath} is not in PLAN_READY status.`);
      console.error(`(Look for a line starting with "**Status:** PLAN_READY" near the top of the file.)`);
      process.exit(1);
    }

    // 4. Construir prompt de ejecución (template fijo, alineado con visor launchConfirm).
    const prompt = `EJECUCION del plan firme generado por el flow de planner ${prepareFlowId}.

Lee ${planPath} — debe estar en Status: PLAN_READY.

Descompon el plan en tasks ejecutivas (impl/test/verify segun corresponda) y arranca el flow de implementacion.

Emite <<COORDINATOR_DONE>> cuando hayas creado las tasks.`;

    if (dryRun) {
      console.log(`[dry-run] Plan path: ${planPath}`);
      console.log(`[dry-run] Prepare flow: ${prepareFlowId} (status=${prepare.status})`);
      console.log(`[dry-run] Would create new flow with prompt:`);
      console.log(`---`);
      console.log(prompt);
      console.log(`---`);
      console.log(`[dry-run] Would set parent_flow_id=${prepareFlowId} on the new flow.`);
      return;
    }

    // 5. Crear nuevo flow + task coordinator-seed (idéntico a coordinate.ts pero con parent_flow_id).
    const flowId = ulid();
    const taskId = ulid();
    const timestamp = now();

    const flowName = `confirm-${prepare.name}`.slice(0, 80);

    createFlow(db, {
      id: flowId,
      name: flowName,
      status: 'queued',
      autonomy: 'L3',
      created_at: timestamp,
      updated_at: timestamp,
      parent_flow_id: prepareFlowId,
    });

    createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: 'coordinate',
      agent_id: 'softwarefactory_coordinator',
      status: 'ready',
      input_json: JSON.stringify({
        message: prompt,
        permission_mode: 'acceptEdits',
        max_turns: 60,
      }),
      idempotency_key: `${flowId}-coordinate`,
      created_at: timestamp,
      updated_at: timestamp,
      priority: 10,
    });

    console.log(`Plan confirmed.`);
    console.log(`  Plan source: ${planPath}`);
    console.log(`  Prepare flow: ${prepareFlowId}`);
    console.log(`  Execute flow: ${flowId}`);
    console.log(`  Coordinator task: ${taskId}`);
  } finally {
    db.close();
  }
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
