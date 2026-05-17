#!/usr/bin/env -S npx tsx
// CLI wrapper para las tools del coordinator.
// Permite al coordinator invocar las tools via Bash sin necesidad de MCP server.

import { readFileSync } from 'node:fs';
import { openDb } from '../db/connection.js';
import {
  createCoordinatorTask,
  createTaskDependency,
  createCoordinatorWaiter,
  observeFlowState,
  markCoordinatorDone,
  createNewFlow,
} from './tools.js';

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.error('Usage: cli-tools.ts <command> [args]');
  console.error('Commands: createTask, createDependency, createWaiter, observe, markDone, createFlow');
  process.exit(1);
}

const db = openDb();

try {
  if (command === 'createTask') {
    // Parse args: --flow-id <id> --stage <stage> --agent <agent_id> --message "<msg>" --depends-on <slug1,slug2> --priority N --estimated-minutes M --max-turns T
    const flowId = getArg('--flow-id');
    const stage = getArg('--stage');
    const agentId = getArg('--agent');
    const messageFileArg = getArg('--message-file', true);
    const message = messageFileArg
      ? readFileSync(messageFileArg, 'utf8')
      : getArg('--message');
    const dependsOnRaw = getArg('--depends-on', true); // optional
    const priorityRaw = getArg('--priority', true);
    const estimatedMinutesRaw = getArg('--estimated-minutes', true);
    const maxTurnsRaw = getArg('--max-turns', true);
    const cwdArg = getArg('--cwd', true);
    const addDirRaw = getArg('--add-dir', true);
    const sessionStrategyArg = getArg('--session-strategy', true);

    const dependsOn = dependsOnRaw ? dependsOnRaw.split(',').filter((s) => s.length > 0) : [];
    const priority = priorityRaw ? parseInt(priorityRaw, 10) : 5;
    const estimatedMinutes = estimatedMinutesRaw ? parseInt(estimatedMinutesRaw, 10) : null;
    const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined;
    const addDir = addDirRaw ? addDirRaw.split(',').filter((s) => s.length > 0) : undefined;

    // Validacion de session_strategy
    let sessionStrategy: 'flow-agent-task' | 'none' | undefined = undefined;
    if (sessionStrategyArg) {
      if (sessionStrategyArg !== 'flow-agent-task' && sessionStrategyArg !== 'none') {
        throw new Error(
          `Invalid --session-strategy: ${sessionStrategyArg}. Valid values: flow-agent-task, none`
        );
      }
      sessionStrategy = sessionStrategyArg as 'flow-agent-task' | 'none';
    }

    // Si no se especifica cwd/add_dir/session_strategy, heredar del coordinator seed del mismo flow.
    let cwd: string | undefined = cwdArg || undefined;
    let inheritedAddDir: string[] | undefined = addDir;
    if (!cwd || !inheritedAddDir || !sessionStrategy) {
      const seed = db
        .prepare(
          `SELECT input_json FROM tasks
           WHERE flow_id = ? AND agent_id = 'softwarefactory_coordinator'
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(flowId) as { input_json: string } | undefined;
      if (seed) {
        try {
          const parsed = JSON.parse(seed.input_json);
          if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
          if (!inheritedAddDir && Array.isArray(parsed.add_dir)) {
            inheritedAddDir = parsed.add_dir.filter((d: unknown): d is string => typeof d === 'string');
          }
          if (!sessionStrategy && typeof parsed.session_strategy === 'string') {
            if (parsed.session_strategy === 'flow-agent-task' || parsed.session_strategy === 'none') {
              sessionStrategy = parsed.session_strategy;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    const result = createCoordinatorTask(db, flowId, {
      stage,
      agent_id: agentId,
      message,
      depends_on: dependsOn.length > 0 ? dependsOn : undefined,
      priority,
      estimated_minutes: estimatedMinutes,
      max_turns: maxTurns,
      cwd,
      add_dir: inheritedAddDir,
      session_strategy: sessionStrategy,
    });

    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'createDependency') {
    const flowId = getArg('--flow-id');
    const taskSlug = getArg('--task-slug');
    const dependsOnSlug = getArg('--depends-on-slug');

    createTaskDependency(db, flowId, { task_slug: taskSlug, depends_on_slug: dependsOnSlug });
    console.log(JSON.stringify({ status: 'ok' }, null, 2));
  } else if (command === 'createWaiter') {
    const flowId = getArg('--flow-id');
    const taskSlug = getArg('--task-slug');
    const stepId = getArg('--step-id');
    const kind = getArg('--kind');
    const prompt = getArg('--prompt');
    const schemaJson = getArg('--schema-json');
    const timeoutMsRaw = getArg('--timeout-ms', true);

    const timeoutMs = timeoutMsRaw ? parseInt(timeoutMsRaw, 10) : undefined;

    const result = createCoordinatorWaiter(db, flowId, {
      task_slug: taskSlug,
      step_id: stepId,
      kind,
      prompt,
      schema_json: schemaJson,
      timeout_ms: timeoutMs,
    });

    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'observe') {
    const flowId = getArg('--flow-id');
    const result = observeFlowState(db, flowId);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'markDone') {
    const flowId = getArg('--flow-id');
    const summary = getArg('--summary');
    markCoordinatorDone(db, flowId, { summary });
  } else if (command === 'createFlow') {
    // Parse args: --name <slug> --message "<msg>" --message-file <path> --autonomy <L0|L1|L2|L3> --seed-agent <agent_id> --seed-stage <stage> --cwd <path> --add-dir <comma-separated> --session-strategy <flow-agent-task|none> --max-turns <N> --priority <N>
    const name = getArg('--name');
    const messageFileArg = getArg('--message-file', true);
    const message = messageFileArg
      ? readFileSync(messageFileArg, 'utf8')
      : getArg('--message');
    const autonomyArg = getArg('--autonomy', true);
    const seedAgentArg = getArg('--seed-agent', true);
    const seedStageArg = getArg('--seed-stage', true);
    const cwdArg = getArg('--cwd', true);
    const addDirRaw = getArg('--add-dir', true);
    const sessionStrategyArg = getArg('--session-strategy', true);
    const maxTurnsRaw = getArg('--max-turns', true);
    const priorityRaw = getArg('--priority', true);

    // Validar autonomy
    let autonomy: 'L0' | 'L1' | 'L2' | 'L3' = 'L3';
    if (autonomyArg) {
      if (!['L0', 'L1', 'L2', 'L3'].includes(autonomyArg)) {
        throw new Error(`Invalid --autonomy: ${autonomyArg}. Valid values: L0, L1, L2, L3`);
      }
      autonomy = autonomyArg as 'L0' | 'L1' | 'L2' | 'L3';
    }

    // Validar session_strategy
    let sessionStrategy: 'flow-agent-task' | 'none' | undefined = undefined;
    if (sessionStrategyArg) {
      if (!['flow-agent-task', 'none'].includes(sessionStrategyArg)) {
        throw new Error(
          `Invalid --session-strategy: ${sessionStrategyArg}. Valid values: flow-agent-task, none`
        );
      }
      sessionStrategy = sessionStrategyArg as 'flow-agent-task' | 'none';
    }

    const addDir = addDirRaw ? addDirRaw.split(',').filter((s) => s.length > 0) : undefined;
    const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined;
    const priority = priorityRaw ? parseInt(priorityRaw, 10) : 10;

    const result = createNewFlow(db, {
      name,
      message,
      autonomy,
      seed_agent_id: seedAgentArg || undefined,
      seed_stage: seedStageArg || undefined,
      cwd: cwdArg || undefined,
      add_dir: addDir,
      session_strategy: sessionStrategy,
      max_turns: maxTurns,
      priority,
    });

    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
} catch (err) {
  console.error(JSON.stringify({ error: String(err) }, null, 2));
  process.exit(1);
} finally {
  db.close();
}

function getArg(flag: string, optional: boolean = false): string {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    if (optional) return '';
    console.error(`Missing required argument: ${flag}`);
    process.exit(1);
  }
  const value = args[index + 1];
  return value ?? '';
}
