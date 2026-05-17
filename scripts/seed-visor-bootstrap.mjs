#!/usr/bin/env node
// Seed: flow 1 de 12 — visor-bootstrap. Configura el server Hono basico + 1 endpoint /health.
// El decide-final emite createFlow visor-api-flows.
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

const visorDir = '/home/angel/projects/visor-orchestrator';
const orcDir = '/home/angel/projects/autonomous-orchestrator';
const orcDb = `${orcDir}/state/orchestrator.db`;
const TURNS = 60;

const message = `Mision: implementar flow 1 de 12 del proyecto VISOR-ORCHESTRATOR — basal del server Hono + endpoint /api/health.

CONTEXTO DEL PROYECTO COMPLETO:
- Spec maestro: ${orcDir}/.claude/teams/softwarefactory/projects/data/meetings/2026-05-17-spec-ui-visor-orchestrator.md (LEE PRIMERO el spec entero, lo que sigue es solo el alcance de ESTE flow).
- Repo ya bootstrapeado en ${visorDir} con: package.json, tsconfig.json, vite.config.js, playwright.config.ts, README.md, .gitignore, y deps instaladas (hono, @hono/node-server, better-sqlite3, vite, playwright, tsx, typescript).
- Cadena de 12 flows planificada. Tras este flow, encadenamos a visor-api-flows.

ALCANCE DE ESTE FLOW (visor-bootstrap):
- Crear server/index.ts con Hono basico: setup + middleware logger + endpoint GET /api/health.
- Crear server/queries.ts esqueleto (vacio o con un export placeholder) — los queries reales los implementa el siguiente flow.
- El endpoint /api/health debe retornar:
  {
    "ok": true,
    "db_path": "${orcDb}",
    "db_size_kb": <size en kb del archivo orchestrator.db>,
    "db_writable": false,
    "uptime_s": <segundos desde arranque del proceso>,
    "node_version": "<process.version>",
    "build_hash": "dev"
  }
- Verificar que el server arranca: \`npm run dev\` levanta tsx --watch en port 5176.
- 1 spec E2E minimo: tests/e2e/health.spec.ts que hace GET /api/health y verifica ok=true y db_writable=false.

PATHS ABSOLUTOS (criticos):
- Working dir del proyecto: ${visorDir}
- DB del orchestrator a leer: ${orcDb}
- Spec a leer: ${orcDir}/.claude/teams/softwarefactory/projects/data/meetings/2026-05-17-spec-ui-visor-orchestrator.md

REGLAS GLOBALES DEL ORCHESTRATOR (aprendidas de chess):
- Tests pueden modificarse si necesitan ajustes; no hay tests previos a romper.
- NO git commits. Angel maneja git.
- NO inventar paths. Solo usar ${visorDir} y sub-paths.
- Sessions activadas (flow-agent-task).

ALGORITMO DEL FLOW (5 tasks):

Stage 1 - AC (camila, stage=ac-bootstrap):
  * Read del spec entero (~2026-05-17-spec-ui-visor-orchestrator.md).
  * Escribir ${visorDir}/state/ac-bootstrap.md con criterios de aceptacion EXACTOS de esta fase: shape del /api/health, comportamiento read-only verificado, spec de tests/e2e/health.spec.ts.
  Priority 9. max-turns 30.

Stage 2 - IMPL (mateo, stage=impl-bootstrap, depends-on ac-bootstrap):
  * Read ${visorDir}/state/ac-bootstrap.md.
  * Crear ${visorDir}/server/index.ts con Hono + @hono/node-server (port 5176).
  * Crear ${visorDir}/server/queries.ts con import de better-sqlite3 y placeholder export.
  * Crear ${visorDir}/server/db.ts: helper getDb() que abre la DB en readonly. Usar process.env.ORCHESTRATOR_DB_PATH con default ${orcDb}.
  * Endpoint GET /api/health que retorna el JSON del alcance.
  * Verificar manualmente con curl: bash -lc "cd ${visorDir} && (npm run dev > /tmp/visor-dev.log 2>&1 &) && sleep 3 && curl -fs http://localhost:5176/api/health"
  * Matar el dev server al final: pkill -f "tsx.*server/index" o similar (no dejar procesos colgados).
  Priority 8. max-turns ${TURNS}.

Stage 3 - TESTS (sofia, stage=tests-bootstrap, depends-on impl-bootstrap):
  * Read ${visorDir}/state/ac-bootstrap.md y ${visorDir}/server/index.ts.
  * Crear ${visorDir}/tests/e2e/health.spec.ts: hace request.get('/api/health'), verifica status 200, body.ok===true, body.db_writable===false, body.db_size_kb es numero >0.
  * Correr: bash -lc "cd ${visorDir} && DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 timeout 90 npx playwright test tests/e2e/health.spec.ts --reporter=list 2>&1"
  * Si el test falla por bug del codigo, NO arreglar codigo — reportar. Si falla por bug del test, ajustarlo.
  * Escribir ${visorDir}/state/smoke-bootstrap.md con resultado.
  Priority 9. max-turns ${TURNS}.

Stage 4 - DECISION Y HANDOFF (coordinator, stage=decide-bootstrap, depends-on tests-bootstrap):
  * Read ${visorDir}/state/smoke-bootstrap.md.
  * Si test verde y server OK:
    1) Escribir el prompt del siguiente flow a /tmp/visor-api-flows-prompt.txt con Write tool. El prompt debe pedir: implementar GET /api/flows?status=&autonomy=&q= que retorna lista de flows con task_counts agregados (consulta queries.ts), endpoint GET /api/stats con conteos globales, y agregar test e2e flows-list.spec.ts. Detalles tecnicos completos para que el coordinator del flow siguiente arme su plan sin ambiguedad. Referencia paths absolutos a ${visorDir} y ${orcDb}.
    2) Ejecutar el createFlow textual con TODO el bloque:
       npx tsx ${orcDir}/src/coordinator/cli-tools.ts createFlow \\
         --name visor-api-flows \\
         --message-file /tmp/visor-api-flows-prompt.txt \\
         --autonomy L3 \\
         --cwd ${visorDir} \\
         --add-dir ${visorDir},${visorDir}/server,${visorDir}/public,${visorDir}/tests,${visorDir}/state \\
         --session-strategy flow-agent-task \\
         --max-turns ${TURNS} \\
         --priority 10
    3) Emitir <<LOOP_DONE: visor-bootstrap ok, visor-api-flows lanzado>>.
  * Si hay issues: crear waiter pasivo pidiendo a Angel decidir.
  Priority 10. max-turns 35.

REGLAS CRITICAS PARA EL HANDOFF (aprendido de chess):
- El comando createFlow debe ejecutarse LITERAL desde Bash. NO inventar paths para --cwd.
- /tmp/visor-api-flows-prompt.txt debe existir antes de invocar createFlow (Write tool primero).
- El prompt del flow siguiente debe ser RICO: paths absolutos completos, alcance bien definido, y al final el bloque createFlow para el flow N+1 (visor-api-flow-detail). NO dejar que el agente "decida si encadenar" — decirle textualmente "ejecuta este comando".
- ORCHESTRATOR_DB env var YA esta exportada por el dispatcher (fix de hoy). NO necesitas hacer cd al orchestrator.

AHORA: crea las 4 tasks (ac-bootstrap, impl-bootstrap, tests-bootstrap, decide-bootstrap) con sus dependencias y emite <<COORDINATOR_DONE: visor-bootstrap seeded>>.`;

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
).run(flowId, 'visor-bootstrap', ts, ts);

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 60,
  cwd: visorDir,
  add_dir: [visorDir, `${visorDir}/server`, `${visorDir}/public`, `${visorDir}/tests`, `${visorDir}/state`, `${orcDir}/.claude`],
  session_strategy: 'flow-agent-task',
});

db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(taskId, flowId, 'coordinate-seed', 'softwarefactory_coordinator', input, `${flowId}-coordinate-seed`, ts, ts, 10);

console.log(`Flow ${flowId} (visor-bootstrap) created`);
console.log(`Seed task ${taskId} ready`);
console.log(`Cadena: visor-bootstrap -> visor-api-flows -> ... -> visor-deploy-doc (12 flows)`);
db.close();
