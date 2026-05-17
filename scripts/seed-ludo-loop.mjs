#!/usr/bin/env node
// Crea el flow + coordinator seed para el loop de reparacion Playwright en ludo.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const dbPath = resolve(process.cwd(), 'state/orchestrator.db');
const db = new Database(dbPath);

function ulid() {
  // ULID-ish: timestamp(48)+random(80) hex — suficiente para sorting cronologico.
  const t = Date.now().toString(16).padStart(12, '0').toUpperCase();
  const r = randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
  return (t + r).slice(0, 26);
}

const flowId = ulid();
const taskId = ulid();
const ts = Date.now();

const ludoDir = '/home/angel/projects/games/ludo';
const orcDir = '/home/angel/projects/autonomous-orchestrator';
const cliTools = `${orcDir}/src/coordinator/cli-tools.ts`;
const MAX_ITERATIONS = 5;
const TURNS_PER_TASK = 40;

const message = `Mision: ejecutar un loop de auto-reparacion sobre los tests Playwright del proyecto Ludo (${ludoDir}).

CONTEXTO INICIAL — fallos ya detectados en corrida previa:
1. tests/e2e/smoke.spec.ts:14 — navega a /public/ y obtiene 404. baseURL/dev-server mismatch.
2. tests/e2e/tablero-carga.spec.ts:29 — board.locator('.cell') devuelve 77 en vez de 225. Render parcial del grid 15x15 en public/ui.js.
Tests que pasaron: mover-ficha, tirar-dado, victoria, jugar-partida (la suite tiene 6 specs en total).

ALGORITMO QUE DEBES ORQUESTAR (loop hasta MAX_ITERATIONS=${MAX_ITERATIONS} iteraciones o suite verde):

Iteracion N (empezas con N=1):
  Stage 1 - REPARACION (paralelo):
    Por cada fallo conocido, crea UNA task softwarefactory_valeria (frontend) o softwarefactory_mateo (backend) segun corresponda al tipo de bug:
      - bug de routing/dev-server/config -> softwarefactory_dante
      - bug de UI/render/DOM -> softwarefactory_valeria
      - bug de logica de juego/datos -> softwarefactory_mateo
    Cada task debe:
      * Usar rutas absolutas (cwd del dispatcher es ${orcDir}, NO ${ludoDir}).
      * Leer el spec relevante en ${ludoDir}/tests/e2e/<spec>.spec.ts.
      * Leer el codigo de produccion implicado (${ludoDir}/public/ y ${ludoDir}/scripts/).
      * Aplicar el fix MINIMO. NO refactors. NO renombrar. NO tocar tests.
      * NO usar git. Solo editar archivos.
      * Reportar al final: archivo cambiado, lineas, hipotesis verificada.
    Stage en kebab-case: fix-iter${'${N}'}-<slug-del-bug>. Priority 8. max-turns ${TURNS_PER_TASK}.

  Stage 2 - PRUEBAS (depende de TODAS las reparaciones de iter N):
    Crea UNA task softwarefactory_sofia con stage test-iter${'${N}'} que:
      * Espera que el dev server este disponible (el config arranca \`npm run dev\` automaticamente, reuseExistingServer=true).
      * Ejecuta: DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 HEADLESS=false bash -lc "cd ${ludoDir} && timeout 300 npx playwright test --reporter=list 2>&1"
      * Persiste el output completo en ${ludoDir}/state/playwright-iter${'${N}'}.log
      * Resume: passed/failed/skipped y por cada fallo (test name, archivo:linea, mensaje 1-2 lineas, hipotesis 1 linea).
      * NO modifica codigo. Solo prueba y reporta.
    Priority 9. max-turns ${TURNS_PER_TASK}. Depende de todos los fix-iter${'${N}'}-* via --depends-on.

  Stage 3 - DECISION (depende de test-iter${'${N}'}):
    Crea UNA task softwarefactory_coordinator con stage decide-iter${'${N}'} que:
      * Lee ${ludoDir}/state/playwright-iter${'${N}'}.log.
      * Si 0 failed -> emite <<LOOP_DONE: suite verde en iter ${'${N}'}>> y NO crea mas tasks.
      * Si hay failed Y ${'${N}'} < ${MAX_ITERATIONS} -> crea las tasks de la iteracion ${'${N}'}+1 siguiendo este mismo algoritmo (un nuevo bloque reparacion+pruebas+decision). Stage de las nuevas: fix-iter${'${N+1}'}-*, test-iter${'${N+1}'}, decide-iter${'${N+1}'}.
      * Si hay failed Y ${'${N}'} == ${MAX_ITERATIONS} -> crea un waiter pasivo (kind=approve-text) en stage decide-iter${'${N}'} pidiendo a Angel que decida continuar o cortar, con el resumen de fallos pendientes.
      * Termina con <<COORDINATOR_DONE: decision iter ${'${N}'}>>.
    Priority 10. max-turns 30. allowedTools incluye Bash para createTask del cli-tools.
    El prompt de esta task debe contener literalmente las instrucciones de arriba con la N correcta hardcodeada.

REGLAS GLOBALES PARA TUS TASKS:
- Todas las paths absolutas. Nada relativo a cwd.
- Ningun commit git, ningun push.
- Tests NO se tocan; solo codigo de produccion.
- Si un agente no encuentra el bug obvio, debe reportar "no-fix-applied" en su output y NO inventar cambios.
- Cuando crees tasks con createTask, --depends-on usa los slugs de stages previos exactos.

AHORA: crea las tasks de la ITERACION 1 (fix-iter1-smoke-404, fix-iter1-tablero-77celdas, test-iter1, decide-iter1) y emite <<COORDINATOR_DONE: Iter 1 seeded con N tasks>>.`;

const flowStmt = db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
);
flowStmt.run(flowId, 'ludo-playwright-loop', ts, ts);

const taskStmt = db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, '[]')`,
);
const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 60,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`],
});
taskStmt.run(
  taskId,
  flowId,
  'coordinate-seed',
  'softwarefactory_coordinator',
  input,
  `${flowId}-coordinate-seed`,
  ts,
  ts,
  10,
);

console.log(`Flow ${flowId} created`);
console.log(`Coordinator seed task ${taskId} ready`);
db.close();
