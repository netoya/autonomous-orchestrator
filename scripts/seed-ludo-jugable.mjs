#!/usr/bin/env node
// Seed: loop "Ludo jugable" — iterar fix/test/inspect/decide hasta que la suite verde
// y la UX no tenga bloqueos. Permite WebSearch para reglas oficiales.
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
const MAX_ITERATIONS = 6;
const TURNS_PER_TASK = 60;

const message = `Mision: dejar el juego Ludo (${ludoDir}) en estado JUGABLE END-TO-END.

CRITERIO DE EXITO (LOOP_DONE):
- jugar-partida.spec.ts pasa en green sin trampas (50 turnos completos, sin atascos, sin re-tries).
- Toda la suite Playwright pasa: 6/6 specs green.
- Lucas (UX) reporta 0 issues criticos ni altos en su inspeccion visual.

CONTEXTO PREVIO IMPORTANTE:
- El proyecto ya paso por 2 loops (funcional + UX). Hay reportes en ${ludoDir}/state/{ux-report-iter1,2,3.md, playwright-iter1,2,3.log}.
- LEER ${ludoDir}/state/ux-report-iter3.md PRIMERO para entender que se considero "aceptable" en la ultima corrida y que quedo como cosmetico bajo.
- Hay screenshots historicas en ${ludoDir}/state/screenshots/iter-{1,2,3}/ para comparacion visual.
- Las reglas oficiales de Ludo clasico estan resumidas mas abajo en este prompt. Si surge duda, releer la seccion REGLAS LUDO.

REGLAS LUDO CLASICO (referencia):
- Tablero: cruz de 15x15 = 225 celdas. 4 zonas de "casa" en las esquinas (rojo arriba-izq, azul arriba-der, amarillo abajo-der, verde abajo-izq, o cualquier convencion consistente).
- Camino externo: 52 celdas que forman el circuito completo.
- Columnas de meta: 5 celdas por color que llevan al centro (4 celdas + casilla central de meta).
- Cada jugador: 4 fichas. Empiezan en "casa" (la zona de inicio coloreada de su esquina).
- Salir de casa: requiere tirar un 6. La ficha entra en la celda de salida (casilla coloreada al borde de la casa). Si no se tira 6, la ficha queda en casa.
- Bonus por 6: cuando un jugador tira 6, tiene turno extra. 3 seises seguidos pierden el turno (regla anti-bloqueo).
- Captura: si una ficha cae en una celda ocupada por una ficha enemiga (NO en casilla segura), la ficha enemiga vuelve a su casa.
- Casillas seguras: ~8 celdas marcadas con estrella (★) donde NO hay captura. Las celdas de salida de cada color tambien son seguras.
- Meta: la ficha entra a su columna de meta cuando completa el circuito. Llega a la meta central con valor exacto (si saca mas de lo necesario, la ficha no se mueve o rebota — convencion del proyecto a documentar).
- Victoria: el primer jugador que lleva sus 4 fichas a la meta gana.
- Auto-skip: si tras tirar no hay ninguna ficha que pueda mover, el turno pasa automaticamente al siguiente jugador.

ALGORITMO DEL LOOP (max ${MAX_ITERATIONS} iteraciones):

Para cada iteracion N (empezando en 1):

  Stage 1 - PRUEBAS Y CAPTURA (sofia, stage=test-iter${'${N}'}):
    * Ejecutar: DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 HEADLESS=false bash -lc "cd ${ludoDir} && rm -rf test-results && timeout 360 npx playwright test --reporter=list 2>&1"
    * Persistir output completo en ${ludoDir}/state/playwright-jugable-iter${'${N}'}.log.
    * INMEDIATAMENTE despues: mkdir -p ${ludoDir}/state/screenshots/jugable-iter${'${N}'} && cp ${ludoDir}/test-results/*.png ${ludoDir}/state/screenshots/jugable-iter${'${N}'}/ 2>/dev/null || true
    * Reportar passed/failed/skipped y lista de PNGs disponibles con paths absolutos.
    * NO modificar codigo. Solo correr y reportar.
    Priority 9. max-turns ${TURNS_PER_TASK}.

  Stage 2 - INSPECCION UX (lucas, stage=inspect-iter${'${N}'}, depends-on test-iter${'${N}'}):
    * Leer las screenshots en ${ludoDir}/state/screenshots/jugable-iter${'${N}'}/ con Read (acepta paths absolutos a PNG).
    * Si tiene dudas sobre reglas de Ludo, releer la seccion REGLAS LUDO de su prompt (esta embebida).
    * Evaluar por ZONAS:
      A. Tablero: cruz 15x15, 4 cuadrantes color, columnas meta, centro/triangulo final, casillas seguras (~8 totales).
      B. HUD: indicador de turno + dado + boton "Tirar" con estados claros (activo/disabled/animando).
      C. Fichas: 16 fichas (4 por color), distinguibles, posicion correcta, z-index sobre celdas.
      D. Estados especiales: capturas, bonus por 6, banner victoria.
    * Reporte en ${ludoDir}/state/ux-jugable-iter${'${N}'}.md con severidad (critica|alta|media|baja) por gap.
    * NO modificar codigo. Solo inspeccionar.
    Priority 9. max-turns ${TURNS_PER_TASK}.

  Stage 3 - DECISION (coordinator, stage=decide-iter${'${N}'}, depends-on inspect-iter${'${N}'}):
    * Leer ${ludoDir}/state/playwright-jugable-iter${'${N}'}.log y ${ludoDir}/state/ux-jugable-iter${'${N}'}.md.
    * Si TODO esta verde (suite 6/6 + 0 criticos/altos UX): emitir <<LOOP_DONE: jugable en iter ${'${N}'}>> y NO crear mas tasks.
    * Si N == ${MAX_ITERATIONS} y aun hay issues: crear waiter pasivo kind=approve-text con el resumen de lo pendiente para que Angel decida.
    * Si hay issues Y N < ${MAX_ITERATIONS}: crear hasta 4 fix tasks para iter ${'${N+1}'} priorizando bloqueantes funcionales > UX critico > UX alto. Para cada fix:
      - Elegir agente segun tipo:
        * Bugs de logica de juego (turno, dado, captura, meta) -> softwarefactory_mateo (backend mental, aunque sea JS frontend).
        * Bugs de UI/render/CSS -> softwarefactory_valeria.
        * Bugs de tests E2E (selectores rotos, expectativas erradas) -> softwarefactory_sofia (TESTS SI SE PUEDEN MODIFICAR si el spec no refleja reglas reales del juego — pero documentar el por que en el output).
        * Bugs de UX visual/layout -> softwarefactory_valeria.
      - Stage: fix-iter${'${N+1}'}-<slug-corto> (max 30 chars).
      - Cada fix debe:
        * Leer el reporte ux-jugable-iter${'${N}'}.md y el log playwright-jugable-iter${'${N}'}.log.
        * Aplicar fix minimo, sin refactors ni cleanups gratis.
        * NO commits git.
        * Reportar archivo:lineas y diff resumen.
        * max-turns ${TURNS_PER_TASK}. priority 8.
    * Luego crear el bloque test-iter${'${N+1}'} (depends-on los fixes) + inspect-iter${'${N+1}'} + decide-iter${'${N+1}'}.
    * Emitir <<COORDINATOR_DONE: decision iter ${'${N}'}>>.
    Priority 10. max-turns 40.

REGLAS GLOBALES:
- Rutas absolutas siempre. Cwd del dispatcher es el orchestrator, NO el ludo.
- Sin WebSearch ni acceso a internet. Las reglas de Ludo estan inline en el prompt (REGLAS LUDO).
- Tests Playwright SE PUEDEN MODIFICAR si la prueba esta mal escrita o no refleja una regla real. Documentar el cambio en el output del fix.
- Sessions activadas (flow-agent-task): cada agente reusa contexto entre retries del mismo task. Eficiente.
- Si un fix falla repetidamente (tick G ya creo coordinator-recovery y este tambien fallo), Tick G abre waiter pasivo automaticamente — Angel decide ahi.
- Para verificar visualmente, los screenshots NUEVOS de cada iter quedan en jugable-iter${'${N}'}/, NO sobrescriben las viejas (uxploop iter1/2/3).

AHORA: crear las tasks de la ITERACION 1 (test-iter1, inspect-iter1, decide-iter1) y emitir <<COORDINATOR_DONE: Iter 1 jugable seeded>>.`;

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
).run(flowId, 'ludo-jugable-loop', ts, ts);

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 60,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`, `${ludoDir}/state/screenshots`, `${ludoDir}/tests`, `${ludoDir}/public`],
  session_strategy: 'flow-agent-task',
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

console.log(`Flow ${flowId} (ludo-jugable-loop) created`);
console.log(`Coordinator seed task ${taskId} ready`);
console.log(`Session strategy: flow-agent-task`);
console.log(`Max iterations: ${MAX_ITERATIONS}`);
db.close();
