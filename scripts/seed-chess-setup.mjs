#!/usr/bin/env node
// Seed: flow chess-setup — primera fase del proyecto chess.
// Objetivo: tablero 8x8 funcional + estado inicial + tests basicos.
// Al terminar, su decide-final emite createFlow para chess-piece-pawn.
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

const chessDir = '/home/angel/projects/games/chess';
const orcDir = '/home/angel/projects/autonomous-orchestrator';
const TURNS = 70;

const message = `Mision: implementar el TABLERO de ajedrez 8x8 funcional como primera fase del proyecto chess.

CONTEXTO DEL PROYECTO:
- Repo: ${chessDir} (ya tiene package.json, playwright.config.ts, public/, tests/e2e/ vacios).
- Dev server: \`npm run dev\` levanta serve en http://localhost:5175.
- Este flow (chess-setup) es la PRIMERA fase. Al terminar, su decide-final emitira un FLOW NUEVO para la primera pieza (peon) via \`createFlow\`. Asi se encadenan: chess-setup -> chess-piece-pawn -> chess-piece-rook -> ... -> chess-piece-king -> chess-check-detection.

ALCANCE DE chess-setup (esta fase, NO mas):
- public/index.html: estructura HTML.
- public/styles.css: tablero 8x8 con casillas alternadas claro/oscuro (colores clasicos: #f0d9b5 / #b58863), dimensiones 600x600.
- public/src/board.js: render del tablero con clases [data-row][data-col] y atributos para cada casilla, sin piezas todavia.
- public/src/state.js: state inicial vacio (sin piezas), turno blancas, sin moves.
- tests/e2e/tablero-carga.spec.ts: 1 spec que verifica que carga el tablero con 64 celdas + colores alternados correctos.

REGLAS BASICAS DEL TABLERO DE AJEDREZ (referencia):
- 8 filas x 8 columnas = 64 casillas.
- Convencion: filas numeradas 1-8 (desde abajo = blancas), columnas a-h (de izquierda a derecha mirando desde blancas).
- Casilla (1,a) abajo-izquierda DEBE ser OSCURA (a1 oscura).
- Casilla (1,h) abajo-derecha DEBE ser CLARA (h1 clara).
- Patron checkerboard: las celdas se alternan; una celda (r,c) es clara si (r+c) es par, oscura si impar (o invertido segun convencion).
- Validar visualmente con screenshot: tablero cuadrado, 64 celdas claras/oscuras alternadas.

ALGORITMO DEL FLOW (max 1 ronda + retries):

Stage 1 - DISENO (lucas, stage=design-board):
  * Read /home/angel/projects/games/chess/README.md y package.json.
  * Definir el layout y los design tokens (colores, dimensiones, fuentes).
  * Producir /home/angel/projects/games/chess/state/design-board.md con: dimensiones, colores hex, clases CSS sugeridas, estructura HTML sugerida (boceto en codigo).
  * NO escribir codigo de produccion.
  Priority 9. max-turns ${TURNS}.

Stage 2 - IMPLEMENTACION (valeria, stage=implement-board, depends-on design-board):
  * Read /home/angel/projects/games/chess/state/design-board.md.
  * Crear public/index.html, public/styles.css, public/src/board.js, public/src/state.js segun el diseno.
  * El tablero debe renderizar al cargar la pagina sin requerir clicks.
  * Cada casilla debe tener: \`data-row\` (1-8), \`data-col\` (a-h), clase \`square--light\` o \`square--dark\`, \`data-testid="square-{col}{row}"\` (ej: data-testid="square-a1").
  * SIN piezas todavia.
  * Reportar archivos creados con tamanios.
  Priority 8. max-turns ${TURNS}.

Stage 3 - TESTS (sofia, stage=test-board, depends-on implement-board):
  * Crear /home/angel/projects/games/chess/tests/e2e/tablero-carga.spec.ts con:
    - Verificar que existe selector [data-testid="board"] o equivalente
    - Verificar 64 elementos de casilla
    - Verificar que a1 tiene clase square--dark (a1 es oscura por convencion)
    - Verificar que h1 tiene clase square--light (h1 es clara)
    - Verificar que h8 tiene clase square--dark (esquina opuesta diagonal, misma paridad que a1)
  * Levantar dev server si hace falta, correr playwright. Si los tests fallan por bug del codigo, NO arreglar codigo — reportar el fallo para que el decide cree un fix-task.
  * Si los tests fallan por bug en el TEST (selectores mal, expectativas raras), si arreglar el test.
  * Tomar screenshot full-page del tablero al cargar en /home/angel/projects/games/chess/state/screenshots/tablero-inicial.png.
  * Reportar passed/failed con detalles.
  Priority 9. max-turns ${TURNS}.

Stage 4 - INSPECCION (lucas, stage=inspect-board, depends-on test-board):
  * Read del screenshot /home/angel/projects/games/chess/state/screenshots/tablero-inicial.png.
  * Verificar visualmente:
    - Tablero es cuadrado, ~600x600.
    - 64 celdas claramente distinguibles.
    - Colores alternados correctos.
    - Esquina a1 (abajo-izq) es oscura, h1 (abajo-der) es clara.
  * Reporte en /home/angel/projects/games/chess/state/inspect-board.md con severidad (critica|alta|media|baja) por gap.
  Priority 9. max-turns ${TURNS}.

Stage 5 - DECISION Y AUTO-ENCADENAMIENTO (coordinator, stage=decide-setup, depends-on inspect-board):
  * Read /home/angel/projects/games/chess/state/inspect-board.md y reporte de tests.
  * Si todo verde (suite passed Y 0 criticos/altos UX):
    1. Emitir el siguiente flow para la primera pieza con:
       \`\`\`
       PROMPT_FILE=/tmp/chess-piece-pawn-prompt.txt
       cat > $PROMPT_FILE <<'PROMPT'
       Mision: implementar la pieza PEON (pawn) en chess. La fase chess-setup ya termino (tablero 8x8 OK).

       ALCANCE chess-piece-pawn:
       - Agregar las 16 piezas peon (8 blancas en fila 2, 8 negras en fila 7) al state inicial.
       - Renderizar las piezas en el tablero como elementos con data-testid="piece-{color}-pawn-{col}{row}".
       - Implementar reglas del peon:
         * Mueve 1 casilla adelante (blanco hacia arriba, negro hacia abajo) si la casilla esta vacia.
         * Desde su fila inicial (2 para blanco, 7 para negro) puede mover 2 casillas si ambas estan vacias.
         * Captura en diagonal hacia adelante (1 casilla diagonal solo si hay pieza enemiga).
         * NO incluir: promocion, en passant (eso para fase avanzada futura).
       - Click sobre una pieza propia muestra casillas legales destacadas. Click sobre casilla legal mueve.
       - Click fuera o sobre otra propia cambia seleccion. NO permitir mover pieza enemiga.
       - Tests E2E:
         * peon-render.spec.ts: 16 peones renderizados en posicion inicial correcta.
         * peon-mueve-adelante.spec.ts: click peon blanco a2, click a3, verifica movimiento.
         * peon-mueve-doble.spec.ts: a2 puede ir a a4 (doble inicial).
         * peon-captura.spec.ts: setup con peon enemigo en diagonal, captura correcta.
         * peon-bloqueado.spec.ts: peon no puede mover si tiene pieza propia delante.

       Al terminar el flow chess-piece-pawn, emitir createFlow chess-piece-rook.
       PROMPT

       npx tsx ${orcDir}/src/coordinator/cli-tools.ts createFlow \\
         --name chess-piece-pawn \\
         --message-file $PROMPT_FILE \\
         --autonomy L3 \\
         --cwd ${chessDir} \\
         --add-dir ${chessDir},${chessDir}/public,${chessDir}/tests,${chessDir}/state \\
         --session-strategy flow-agent-task \\
         --max-turns ${TURNS} \\
         --priority 10
       \`\`\`
    2. Emitir <<LOOP_DONE: chess-setup ok, chess-piece-pawn lanzado>>.
  * Si hay issues criticos: crear hasta 3 fix tasks (valeria) + nuevo test + verify + decide (ronda 2). Tras 2 rondas sin cerrar, waiter pasivo.
  * Termina con <<COORDINATOR_DONE: decision setup>>.
  Priority 10. max-turns 40.

REGLAS GLOBALES:
- Rutas absolutas siempre.
- NO commits git en chess (Angel lo manejara).
- Sin internet/WebSearch.
- Sessions activadas, los retries reusan contexto.
- Dev server puede quedar corriendo.
- El proximo flow se llama chess-piece-pawn. Su decide-final emitira createFlow chess-piece-rook.

AHORA: crear las 5 tasks del flow (design-board, implement-board, test-board, inspect-board, decide-setup) con sus dependencias correctas, y emitir <<COORDINATOR_DONE: chess-setup seeded>>.`;

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
).run(flowId, 'chess-setup', ts, ts);

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 70,
  cwd: chessDir,
  add_dir: [chessDir, `${chessDir}/public`, `${chessDir}/tests`, `${chessDir}/state`, `${chessDir}/state/screenshots`],
  session_strategy: 'flow-agent-task',
});

db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(taskId, flowId, 'coordinate-seed', 'softwarefactory_coordinator', input, `${flowId}-coordinate-seed`, ts, ts, 10);

console.log(`Flow ${flowId} (chess-setup) created`);
console.log(`Seed task ${taskId} ready`);
console.log(`Auto-chain: chess-setup -> chess-piece-pawn -> chess-piece-rook -> ... -> chess-piece-king -> chess-check-detection`);
db.close();
