#!/usr/bin/env node
// 1. fulfill waiter de recovery con "skip" para destrabar.
// 2. Crear nueva task fix-ux-iter3-auto-skip-retry con timeout 20 min y max-turns 80.
// 3. Reapuntar dependencia de test-iter3 desde el auto-skip viejo (failed) al retry nuevo.
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

const FLOW = '019E36762A6E87B72470C32744';
const OLD_AUTO_SKIP = '01KRV8NETFYQH5ZTEFV7RVXHQC';
const TEST_ITER3 = '01KRV8PETZDH4TBXM1QTXXFH7T';
const ts = Date.now();
const ludoDir = '/home/angel/projects/games/ludo';

// 1. fulfill waiter pendiente
const waiterRes = db
  .prepare(
    `UPDATE waiters SET status='fulfilled', value_json=?, fulfilled_by='angel', fulfilled_at=? WHERE flow_id=? AND status='waiting'`,
  )
  .run(
    JSON.stringify({ decision: 'skip', reason: 'retry-with-extended-timeout', reviewed_by: 'angel' }),
    ts,
    FLOW,
  );
console.log(`waiter fulfilled: ${waiterRes.changes}`);

// 2. crear retry task con stage NUEVO (idem-key unico)
const retryStage = 'fix-ux-iter3-auto-skip-retry';
const retryId = ulid();
const message = `Fix UX iter-3 RETRY: Auto-skip de turno cuando no hay jugadas posibles.

CONTEXTO: el intento anterior con max_turns=40 y timeout 10 min fue cortado por SIGTERM. Esta retry tiene 20 min y max_turns 80.

PRIMERO leer /home/angel/projects/games/ludo/state/ux-report-iter2.md (Zona D: Estados especiales) y el log /home/angel/projects/games/ludo/state/playwright-iter2.log (test jugar-partida.spec.ts falla con 'sin movimientos y dado sigue disabled - no hay auto-skip' en turnos 9 y 10).

PROBLEMA: cuando el jugador tira el dado y no hay fichas movibles, se muestra el toast 'sin jugadas, pasando turno...' y el boton 'Tirar Dado' queda disabled, pero el turno NO rota automaticamente, bloqueando la partida indefinidamente.

ESTRATEGIA RECOMENDADA (eficiente, no perder tiempo en exploracion):
1. grep -rn "sin jugadas" /home/angel/projects/games/ludo/public/ para localizar la rama exacta.
2. Read del archivo encontrado (probable: public/src/game.js o turn-engine).
3. Ver donde se setea el disabled y donde se llamaria nextTurn().
4. Aplicar fix MINIMO: setTimeout(() => nextTurn(), 1500) en esa rama. Asegurar que no se duplique si ya se llama nextTurn() en otra rama.
5. Reportar archivo:lineas modificadas y el diff sumario (3-5 lineas).

NO crear tests nuevos. NO commits. Solo modificar codigo en /home/angel/projects/games/ludo/public/.`;

const input = JSON.stringify({
  message,
  permission_mode: 'acceptEdits',
  max_turns: 80,
  cwd: ludoDir,
  add_dir: [ludoDir, `${ludoDir}/state`],
  timeout_ms: 1_200_000, // 20 min
});

db.prepare(
  `INSERT INTO tasks (
    id, flow_id, stage, agent_id, status, input_json,
    idempotency_key, created_at, updated_at, priority, tags_json
  ) VALUES (?, ?, ?, 'softwarefactory_valeria', 'ready', ?, ?, ?, ?, ?, '[]')`,
).run(retryId, FLOW, retryStage, input, `${FLOW}-${retryStage}`, ts, ts, 8);
console.log(`retry task created: ${retryId} (stage=${retryStage})`);

// 3. reapuntar dependencia de test-iter3 desde el viejo al nuevo
const depUpd = db
  .prepare(
    `UPDATE task_dependencies SET depends_on_task_id = ? WHERE task_id = ? AND depends_on_task_id = ?`,
  )
  .run(retryId, TEST_ITER3, OLD_AUTO_SKIP);
console.log(`test-iter3 dependency rewired: ${depUpd.changes}`);

// 4. Tick G ya no debe re-disparar sobre el viejo. Lo marcamos cancelled para limpieza.
db.prepare(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`).run(ts, OLD_AUTO_SKIP);
// El coordinator-recovery-fix-ux-iter3-auto-skip tambien estaba failed; cancelarlo
db.prepare(
  `UPDATE tasks SET status='cancelled', updated_at=? WHERE flow_id=? AND stage='coordinate-recovery-fix-ux-iter3-auto-skip'`,
).run(ts, FLOW);
console.log('old failed tasks marked cancelled (tick G stop)');

db.close();
