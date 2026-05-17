// Tools del coordinator (formato funciones puras, invocadas via CLI wrapper).
// El coordinator las invoca via Bash → npx tsx cli-tools.ts <tool> --params

import type Database from 'better-sqlite3';
import { ulid } from '../lib/ulid.js';
import { now } from '../lib/clock.js';
import { createTask, findTaskByIdempotencyKey, listTasksByFlow } from '../db/dao/tasks.js';
import { createPassiveWaiter, findWaitingByFlow } from '../db/dao/waiters.js';

export interface CreateCoordinatorTaskParams {
  stage: string;
  agent_id: string;
  message: string;
  permission_mode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  priority?: number;
  estimated_minutes?: number | null;
  depends_on?: string[]; // array de slugs (stages) de tasks del mismo flow
  max_turns?: number;
  cwd?: string;
  add_dir?: string[];
  session_strategy?: 'flow-agent-task' | 'none';
}

export interface CreateCoordinatorTaskResult {
  task_id: string;
  slug: string;
  status: 'created' | 'existing';
}

export function createCoordinatorTask(
  db: Database.Database,
  flowId: string,
  params: CreateCoordinatorTaskParams
): CreateCoordinatorTaskResult {
  const timestamp = now();
  const slug = params.stage; // En el MVP, slug = stage
  const idempotencyKey = `${flowId}-${slug}`;

  // Verificar idempotencia
  const existing = findTaskByIdempotencyKey(db, idempotencyKey);
  if (existing) {
    return { task_id: existing.id, slug, status: 'existing' };
  }

  // FIX Bug 2: resolver TODOS los slugs de deps ANTES de insertar la task.
  // Si alguno falla, abortar sin insertar (evita tasks huerfanas en 'queued' sin deps).
  const resolvedDepIds: string[] = [];
  if (params.depends_on && params.depends_on.length > 0) {
    for (const depSlug of params.depends_on) {
      const depId = db
        .prepare('SELECT id FROM tasks WHERE flow_id = ? AND stage = ? LIMIT 1')
        .get(flowId, depSlug) as { id: string } | undefined;
      if (!depId) {
        throw new Error(
          `createCoordinatorTask: dep slug '${depSlug}' for stage '${slug}' no existe en flow ${flowId}. Aborto sin crear task huerfana.`,
        );
      }
      resolvedDepIds.push(depId.id);
    }
  }

  const taskId = ulid();

  // Crear input_json
  const inputJson = JSON.stringify({
    message: params.message,
    permission_mode: params.permission_mode ?? 'acceptEdits',
    max_turns: params.max_turns ?? 60,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.add_dir && params.add_dir.length > 0 ? { add_dir: params.add_dir } : {}),
    ...(params.session_strategy ? { session_strategy: params.session_strategy } : {}),
  });

  // Transaccion: insertar task + deps atomicamente, calcular ready vs queued al final.
  const tx = db.transaction(() => {
    const taskRow = createTask(db, {
      id: taskId,
      flow_id: flowId,
      stage: params.stage,
      agent_id: params.agent_id,
      status: resolvedDepIds.length > 0 ? 'queued' : 'ready',
      input_json: inputJson,
      idempotency_key: idempotencyKey,
      created_at: timestamp,
      updated_at: timestamp,
      priority: params.priority ?? 5,
      estimated_minutes: params.estimated_minutes ?? null,
    });

    // Insertar deps usando IDs ya resueltos (no por slug, evita re-resolver).
    const depStmt = db.prepare(`
      INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, kind, created_at)
      VALUES (?, ?, 'finish-to-start', ?)
    `);
    for (const depId of resolvedDepIds) {
      depStmt.run(taskId, depId, timestamp);
    }

    // Race fix: si todas las deps ya estan done, promover a ready.
    if (resolvedDepIds.length > 0) {
      const pendingDeps = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.depends_on_task_id
           WHERE td.task_id = ?
             AND t.status <> 'done'`,
        )
        .get(taskId) as { count: number };

      if (pendingDeps.count === 0) {
        db.prepare(`UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'queued'`)
          .run(timestamp, taskId);
      }
    }

    return taskRow;
  });

  const taskRow = tx();
  return { task_id: taskRow.id, slug, status: 'created' };
}

export interface CreateTaskDependencyParams {
  task_slug: string;
  depends_on_slug: string;
}

export function createTaskDependency(
  db: Database.Database,
  flowId: string,
  params: CreateTaskDependencyParams
): void {
  const timestamp = now();

  // Resolver slugs a IDs (slug = stage)
  const taskId = resolveSlugToTaskId(db, flowId, params.task_slug);
  const dependsOnTaskId = resolveSlugToTaskId(db, flowId, params.depends_on_slug);

  if (!taskId || !dependsOnTaskId) {
    throw new Error(
      `Cannot resolve slugs: task_slug=${params.task_slug}, depends_on_slug=${params.depends_on_slug}`
    );
  }

  // Insertar dependencia
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, kind, created_at)
    VALUES (?, ?, 'finish-to-start', ?)
  `);

  stmt.run(taskId, dependsOnTaskId, timestamp);
}

function resolveSlugToTaskId(
  db: Database.Database,
  flowId: string,
  slug: string
): string | undefined {
  // En MVP, slug = stage
  const stmt = db.prepare('SELECT id FROM tasks WHERE flow_id = ? AND stage = ? LIMIT 1');
  const row = stmt.get(flowId, slug) as { id: string } | undefined;
  return row?.id;
}

export interface CreateCoordinatorWaiterParams {
  task_slug: string;
  step_id: string;
  kind: string;
  prompt: string;
  schema_json: string;
  timeout_ms?: number;
}

export interface CreateCoordinatorWaiterResult {
  waiter_id: string;
}

export function createCoordinatorWaiter(
  db: Database.Database,
  flowId: string,
  params: CreateCoordinatorWaiterParams
): CreateCoordinatorWaiterResult {
  const timestamp = now();
  const taskId = resolveSlugToTaskId(db, flowId, params.task_slug);

  if (!taskId) {
    throw new Error(`Cannot resolve task_slug: ${params.task_slug}`);
  }

  const timeoutMs = params.timeout_ms ?? 7200000; // 2 horas default
  const expiresAt = timestamp + timeoutMs;

  const waiterId = ulid();

  const waiterRow = createPassiveWaiter(db, {
    id: waiterId,
    flow_id: flowId,
    task_id: taskId,
    step_id: params.step_id,
    kind: params.kind,
    prompt: params.prompt,
    schema_json: params.schema_json,
    timeout_ms: timeoutMs,
    created_at: timestamp,
    expires_at: expiresAt,
  });

  return { waiter_id: waiterRow.id };
}

export interface ObserveFlowStateResult {
  flow_id: string;
  tasks: {
    total: number;
    by_status: Record<string, number>;
    last_failed?: {
      id: string;
      stage: string;
      error: string | null;
    };
  };
  waiters: {
    pending: number;
    ids: string[];
  };
  detected_paths: string[];
}

export function observeFlowState(db: Database.Database, flowId: string): ObserveFlowStateResult {
  // Listar tasks del flow
  const tasks = listTasksByFlow(db, flowId);
  const byStatus: Record<string, number> = {};
  let lastFailed: ObserveFlowStateResult['tasks']['last_failed'] = undefined;

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    if (task.status === 'failed') {
      lastFailed = { id: task.id, stage: task.stage, error: task.error };
    }
  }

  // Listar waiters pending
  const waiters = findWaitingByFlow(db, flowId);
  const waiterIds = waiters.map((w) => w.id);

  // Detectar paths heuristicamente (leer input_json de la task coordinator seed)
  const detectedPaths: string[] = [];
  const coordinatorTask = tasks.find((t) => t.agent_id === 'softwarefactory_coordinator');
  if (coordinatorTask) {
    try {
      const parsed = JSON.parse(coordinatorTask.input_json);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.message === 'string') {
        const pathRegex = /\/home\/angel\/projects\/[^\s]+/g;
        const matches = parsed.message.match(pathRegex);
        if (matches) {
          detectedPaths.push(...matches);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return {
    flow_id: flowId,
    tasks: {
      total: tasks.length,
      by_status: byStatus,
      last_failed: lastFailed,
    },
    waiters: {
      pending: waiters.length,
      ids: waiterIds,
    },
    detected_paths: detectedPaths,
  };
}

export interface MarkCoordinatorDoneParams {
  summary: string;
}

export function markCoordinatorDone(
  db: Database.Database,
  flowId: string,
  params: MarkCoordinatorDoneParams
): void {
  // Solo emitir marker que el dispatcher parseara
  console.log(`<<COORDINATOR_DONE: ${params.summary}>>`);
}
