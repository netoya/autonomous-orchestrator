#!/usr/bin/env node
// Seed: flow corto para validar GEOMETRIA del tablero Ludo.
// Foco: el camino externo de la cruz puede estar incompleto o asimetrico.
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
const TURNS_PER_TASK = 60;

const message = `Mision urgente: el usuario reporto que el TABLERO se ve INCOMPLETO. Falta camino visible. Investigar y arreglar la geometria.

EVIDENCIA DEL USUARIO:
- El usuario abrio el juego en localhost:5174 y observo que el brazo DERECHO del camino externo no llega hasta la columna verde.
- El trofeo central esta visualmente desplazado al borde derecho, no centrado.
- Hay celdas faltantes en el path perimetral.

REGLAS DE GEOMETRIA LUDO CLASICO (referencia):
- Grid total: 15x15 = 225 celdas.
- Cruz simetrica: 4 brazos de 3 celdas de ancho x 6 celdas de largo cada uno.
- Camino externo: 52 celdas en total, recorre el perimetro de la cruz como un circuito cerrado.
- Casas: 4 cuadrantes de 6x6 celdas en las esquinas (uno por color), cada uno con 4 slots para fichas en casa.
- Columnas de meta: 4 columnas (una por color) de 4 celdas cada una, apuntando al centro desde sus brazos.
- Centro: triangulo de meta final con el simbolo 🏆 CENTRADO en la celda (8,8) del grid (la del medio absoluto).
- Salidas: cada color tiene 1 celda de salida en su brazo, marcada de color solid.
- Casillas seguras: 8 estrellas (★) repartidas — las 4 de salida + 4 mas a mitad del recorrido de cada brazo.

ALGORITMO DEL FLOW (corto, max 3 iteraciones):

ITER 1:
  Stage 1 - CAPTURAR (sofia, stage=capture-tablero):
    * Levantar el dev server: bash -lc "cd ${ludoDir} && (npm run dev > state/dev-tmp.log 2>&1 &) && sleep 3"
    * Verificar que responde: curl -s http://localhost:5174/ > /dev/null
    * Crear un script Playwright AD-HOC para tomar screenshot full-page del tablero al cargar (sin partida en curso). El script debe:
      - Navegar a http://localhost:5174/
      - Esperar que [data-testid="board"] sea visible
      - Tomar screenshot full-page en ${ludoDir}/state/screenshots/geometria/tablero-inicial.png
      - Tambien tomar screenshot SOLO del tablero (.board element, no la pagina entera) en ${ludoDir}/state/screenshots/geometria/tablero-solo.png
    * Ademas, ejecutar via Playwright/page.evaluate:
      - Contar el numero TOTAL de celdas en el tablero: document.querySelectorAll('.cell').length
      - Contar las celdas del CAMINO EXTERNO: document.querySelectorAll('.cell.path, .cell--path, [data-path]').length (probar varios selectores)
      - Listar las celdas con su data-row/data-col (o similar) si existen
    * Persistir todo en ${ludoDir}/state/geometria-inspeccion.json con: totalCells, pathCells, sample (primeras 10 celdas con sus coords/clases)
    * Reportar paths absolutos de los artifacts producidos.
    Priority 9. max-turns ${TURNS_PER_TASK}.

  Stage 2 - DIAGNOSTICAR (lucas, stage=diagnose-tablero, depends-on capture-tablero):
    * Leer ${ludoDir}/state/screenshots/geometria/tablero-inicial.png Y tablero-solo.png Y geometria-inspeccion.json.
    * Comparar contra las REGLAS DE GEOMETRIA arriba.
    * Identificar SI HAY UN GAP EN EL CAMINO PERIMETRAL: contar celdas visibles del path en la imagen, ver si el circuito esta cerrado o tiene una "abertura".
    * Inspeccionar el codigo de render para entender de donde sale el bug:
      - Read ${ludoDir}/public/src/board.js (o el archivo principal de render del tablero, hacer Glob si no se llama asi)
      - Read ${ludoDir}/public/src/ui.js si existe
      - Read ${ludoDir}/public/index.html y los CSS asociados (Glob *.css)
    * Producir reporte en ${ludoDir}/state/geometria-diagnostico.md con:
      - "Estado observado": que tiene el tablero actual (numero de celdas, asimetrias, gaps).
      - "Estado esperado": que deberia tener segun reglas clasicas.
      - "Root cause hipotetico" (1-2 lineas): archivo y funcion sospechosa, con linea aproximada.
      - "Fix sugerido" (3-5 lineas): que deberia cambiar concretamente en el codigo.
    * NO modificar codigo en esta task. Solo diagnostico.
    Priority 9. max-turns ${TURNS_PER_TASK}.

  Stage 3 - FIX (valeria, stage=fix-tablero, depends-on diagnose-tablero):
    * Leer ${ludoDir}/state/geometria-diagnostico.md.
    * Aplicar el fix sugerido por Lucas en el archivo que indica (publico/src/*.js o CSS).
    * NO refactor. NO tocar tests todavia.
    * Reportar diff conceptual al final.
    Priority 8. max-turns ${TURNS_PER_TASK}.

  Stage 4 - VERIFICAR (sofia, stage=verify-tablero, depends-on fix-tablero):
    * Re-tomar las screenshots: tablero-inicial-postfix.png y tablero-solo-postfix.png en el mismo dir.
    * Comparar con las pre-fix.
    * Tambien ejecutar la suite Playwright completa: DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 HEADLESS=false bash -lc "cd ${ludoDir} && timeout 300 npx playwright test --reporter=list 2>&1 | tail -30"
    * Reportar: passed/failed de la suite, y comparacion visual de los screenshots (numero de celdas, simetria).
    Priority 9. max-turns ${TURNS_PER_TASK}.

  Stage 5 - DECIDIR (coordinator, stage=decide-tablero, depends-on verify-tablero):
    * Leer reporte de Sofia.
    * Si suite 6/6 verde Y screenshots muestran cruz simetrica completa: emitir <<LOOP_DONE: geometria arreglada>> y NO crear mas tasks.
    * Si aun hay gaps: crear UNA segunda ronda de fix-tablero-2 (valeria) + verify-tablero-2 (sofia) + decide-tablero-2 (coordinator) usando este mismo algoritmo.
    * Si tras 3 rondas no se arreglo: crear waiter pasivo para que Angel decida.
    * Termina con <<COORDINATOR_DONE: decision tablero>>.
    Priority 10. max-turns 30.

REGLAS GLOBALES:
- Rutas absolutas siempre.
- NO commits git.
- El dev server puede quedar corriendo en background (no es problema).
- Sessions activadas, se reusan entre retries del mismo task.
- Sofia puede usar Bash para playwright headed con DISPLAY=:0.
- Lucas usa Read sobre PNGs (capacidad multimodal).

AHORA: crear las tasks de la ronda 1 (capture-tablero, diagnose-tablero, fix-tablero, verify-tablero, decide-tablero) y emitir <<COORDINATOR_DONE: geometria seeded>>.`;

db.prepare(
  `INSERT INTO flows (id, name, status, autonomy, created_at, updated_at)
   VALUES (?, ?, 'queued', 'L3', ?, ?)`,
).run(flowId, 'ludo-geometria-fix', ts, ts);

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 50,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`, `${ludoDir}/state/screenshots`, `${ludoDir}/public`, `${ludoDir}/tests`],
  session_strategy: 'flow-agent-task',
});

db.prepare(
  `INSERT INTO tasks (
     id, flow_id, stage, agent_id, status, input_json,
     idempotency_key, created_at, updated_at, priority, tags_json
   ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(taskId, flowId, 'coordinate-seed', 'softwarefactory_coordinator', input, `${flowId}-coordinate-seed`, ts, ts, 10);

console.log(`Flow ${flowId} (ludo-geometria-fix) created`);
console.log(`Seed task ${taskId} ready`);
db.close();
