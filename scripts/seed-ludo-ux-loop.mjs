#!/usr/bin/env node
// Seed: loop de mejora visual/UX del Ludo.
// Cada iteracion: reparacion -> pruebas (con screenshots) -> inspeccion UX (Lucas) -> decision.
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
const orcDir = '/home/angel/projects/autonomous-orchestrator';
const MAX_ITERATIONS = 4;
const TURNS_PER_TASK = 40;

const message = `Mision: loop de mejora VISUAL/UX del juego Ludo en ${ludoDir}.

CONTEXTO:
- Los tests Playwright ya pasan (suite verde). Esta mision NO es funcional sino visual.
- El spec ${ludoDir}/tests/e2e/jugar-partida.spec.ts ya toma 5 screenshots por corrida (01-estado-inicial, 02-antes-primer-dado, 03-despues-primer-dado, 04-despues-primer-movimiento, 05-estado-final) en ${ludoDir}/test-results/.
- IMPORTANTE: Playwright BORRA test-results/ al inicio de cada corrida. Por eso cada test-iter-N debe COPIAR esos PNG a ${ludoDir}/state/screenshots/iter-N/ inmediatamente despues.
- Objetivo final: el juego debe verse como un Ludo clasico — 4 zonas de casa coloreadas, cruz central con caminos, meta central, dado y HUD claros, banner victoria visible.

ZONAS UX A EVALUAR (marco fijo para Lucas):
A. **Tablero (grid 15x15)**: forma de cruz, 4 cuadrantes de casa coloreados (rojo/verde/amarillo/azul), camino externo de 52 celdas, columnas de meta (4 celdas por color), centro/meta final, celdas seguras marcadas.
B. **HUD**: indicador de turno actual (de quien es), dado (con valor 1-6 o "?"), boton/disparador para tirar.
C. **Fichas**: 16 fichas (4 por color), visibles en sus casas iniciales, distinguibles entre si, resaltadas cuando son movibles.
D. **Estados especiales**: banner victoria, captura (ficha vuelve a casa), bonus por sacar 6.

ALGORITMO (loop hasta MAX_ITERATIONS=${MAX_ITERATIONS}):

Iteracion N (N empieza en 1):
  Stage 1 - PRUEBAS Y CAPTURA:
    Crea UNA task softwarefactory_sofia stage=test-iter${'${N}'}:
      * Ejecuta: DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 HEADLESS=false bash -lc "cd ${ludoDir} && rm -rf test-results && timeout 300 npx playwright test --reporter=list 2>&1"
      * Persiste el output en ${ludoDir}/state/playwright-iter${'${N}'}.log
      * INMEDIATAMENTE despues copia screenshots: mkdir -p ${ludoDir}/state/screenshots/iter-${'${N}'} && cp ${ludoDir}/test-results/*.png ${ludoDir}/state/screenshots/iter-${'${N}'}/
      * Lista los PNG copiados con \`ls -la ${ludoDir}/state/screenshots/iter-${'${N}'}/\`
      * Reporta: passed/failed/skipped + lista absoluta de PNGs disponibles para Lucas.
    Priority 9. max-turns ${TURNS_PER_TASK}. SIN dependencias en iter 1 (los fixes vienen DESPUES de la inspeccion en este flow).

  Stage 2 - INSPECCION UX (depende de test-iter${'${N}'}):
    Crea UNA task softwarefactory_lucas stage=inspect-iter${'${N}'}:
      * Lee las 5 screenshots con Read (acepta paths absolutos): ${ludoDir}/state/screenshots/iter-${'${N}'}/{01-estado-inicial,02-antes-primer-dado,03-despues-primer-dado,04-despues-primer-movimiento,05-estado-final}.png
      * Para cada zona (A/B/C/D arriba) evalua: que se ve, que se espera de un Ludo clasico, gap concreto. Cita la screenshot por nombre.
      * Produce un reporte estructurado y lo guarda en ${ludoDir}/state/ux-report-iter${'${N}'}.md con secciones:
        ## Zona A - Tablero
        - Observado: ...
        - Esperado: ...
        - Gap: ...
        - Severidad: critica|alta|media|baja
        - Fix sugerido (1-2 lineas, archivo:zona): ...
        (repetir para B, C, D)
        ## Prioridades para la siguiente iteracion
        - Lista ordenada de fixes (top N) con archivo objetivo y categoria (CSS/HTML/render-logic).
      * NO modifica codigo de produccion. Solo analiza y reporta.
    Priority 9. max-turns ${TURNS_PER_TASK}. Depende de test-iter${'${N}'}.

  Stage 3 - DECISION (depende de inspect-iter${'${N}'}):
    Crea UNA task softwarefactory_coordinator stage=decide-iter${'${N}'}:
      * Lee ${ludoDir}/state/ux-report-iter${'${N}'}.md y ${ludoDir}/state/playwright-iter${'${N}'}.log.
      * Si Lucas reporta "0 issues criticos ni altos" Y suite verde -> <<LOOP_DONE: ux ok en iter ${'${N}'}>> y NO crea mas tasks.
      * Si N == ${MAX_ITERATIONS} -> crea waiter pasivo (kind=approve-text) pidiendo a Angel decidir si seguir, con resumen del ultimo reporte UX.
      * Si hay gaps Y N < ${MAX_ITERATIONS} -> crea tasks de FIX VISUAL para la iter ${'${N+1}'} y luego el bloque test/inspect/decide:
        - Por cada fix sugerido por Lucas (max 3 por iter), crea task softwarefactory_valeria stage=fix-ux-iter${'${N+1}'}-<slug-corto>:
            * Lee ${ludoDir}/state/ux-report-iter${'${N}'}.md para entender el problema.
            * Aplica fix MINIMO en CSS/HTML/JS de ${ludoDir}/public/.
            * NO tocar tests. NO git. Reportar archivo y diff sumario.
            * Priority 8. max-turns ${TURNS_PER_TASK}.
        - Crea test-iter${'${N+1}'} (sofia, depends-on fix-ux-iter${'${N+1}'}-*).
        - Crea inspect-iter${'${N+1}'} (lucas, depends-on test-iter${'${N+1}'}).
        - Crea decide-iter${'${N+1}'} (coordinator, depends-on inspect-iter${'${N+1}'}) con el mismo algoritmo aplicado a iter ${'${N+1}'}.
      * Termina con <<COORDINATOR_DONE: decision iter ${'${N}'}>>.
    Priority 10. max-turns 35.

REGLAS GLOBALES:
- Rutas absolutas siempre.
- Tests NO se modifican (esta es mejora visual; los tests ya validan funcionalidad).
- NO git commits.
- Si Lucas no encuentra screenshots (porque test-iter borro test-results sin copiar), reportar "no-screenshots-iter-N" y el coordinator decide bloqueador.

AHORA: crea las tasks de la ITERACION 1 (test-iter1, inspect-iter1, decide-iter1) y emite <<COORDINATOR_DONE: Iter 1 ux seeded>>.`;

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
).run(flowId, 'ludo-ux-loop', ts, ts);

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 60,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`, `${ludoDir}/state/screenshots`],
});

db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(
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

console.log(`Flow ${flowId} (ludo-ux-loop) created`);
console.log(`Coordinator seed task ${taskId} ready`);
db.close();
