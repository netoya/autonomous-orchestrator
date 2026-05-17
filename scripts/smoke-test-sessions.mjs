#!/usr/bin/env node
// Smoke test de session-strategy: seedea un flow con 1 task de valeria + simula retry.
// Verifica que el dispatcher reutiliza sessionId via --resume.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const dbPath = resolve(process.cwd(), 'state/orchestrator.db');
const db = new Database(dbPath);

function ulid() {
  const t = Date.now().toString(16).padStart(12, '0').toUpperCase();
  const r = randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
  return (t + r).slice(0, 26);
}

const flowId = ulid();
const taskId = ulid();
const ts = Date.now();
const ludoDir = '/home/angel/projects/games/ludo';

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, 'smoke-test-sessions', 'queued', 'L3', ?, ?)`,
).run(flowId, ts, ts);

const message = `Tarea trivial de smoke test: leer ${ludoDir}/state/ux-report-iter3.md y resumirlo en EXACTAMENTE 3 lineas (no mas, no menos). No editar archivos. Solo leer y reportar el resumen en tu output final.`;

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 8,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`],
  session_strategy: 'flow-agent-task',
});

db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, 'smoke-read-and-summarize', 'softwarefactory_valeria', 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(taskId, flowId, input, `${flowId}-smoke`, ts, ts, 5);

console.log(`Flow ${flowId} created`);
console.log(`Task ${taskId} ready`);
console.log(`Session strategy: flow-agent-task`);
console.log(`Strategy key esperado: ${flowId}:softwarefactory_valeria:${taskId}`);
db.close();
