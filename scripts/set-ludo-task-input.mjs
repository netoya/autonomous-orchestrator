#!/usr/bin/env node
// Actualiza el input_json y el stage de un task para apuntar a la mision ludo headed.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: set-ludo-task-input.mjs <taskId>');
  process.exit(1);
}

const dbPath = resolve(process.cwd(), 'state/orchestrator.db');
const db = new Database(dbPath);

const prompt = `Mision: ejecutar la suite Playwright E2E del proyecto Ludo en modo HEADED y reportar fallos.

REGLAS ESTRICTAS:
- NO modifiques ningun archivo del proyecto Ludo. Solo lectura + ejecucion de tests.
- El proyecto Ludo vive en: /home/angel/projects/games/ludo
- Usa rutas absolutas en cada comando Bash (no dependas de cwd).
- Display X disponible: DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3

Pasos:
1. Verifica que existe /home/angel/projects/games/ludo/playwright.config.ts con:
   ls -la /home/angel/projects/games/ludo/tests/e2e/
2. Ejecuta la suite en modo headed (con timeout 5 min):
   DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.L4W5O3 HEADLESS=false \\
     bash -lc "cd /home/angel/projects/games/ludo && timeout 300 npx playwright test --reporter=list 2>&1"
3. Captura el output completo (passed/failed/skipped).
4. Si hay tests fallidos, lee los traces relevantes en /home/angel/projects/games/ludo/test-results/ y resume causa raiz probable (mensaje de error + linea del spec) para cada fallo.
5. NO intentes arreglar nada. Solo reporta.

Formato del reporte final (al usuario):
- Resumen: X passed, Y failed, Z skipped, tiempo total.
- Lista de fallos: por cada uno -> nombre del test, archivo:linea, mensaje de error de 1-2 lineas, hipotesis de causa raiz en 1 linea.
- Si la suite no pudo ni arrancar (server caido, browser no instalado, display no accesible), reporta ese bloqueador y los logs textuales que lo demuestran.

Termina tu turno cuando hayas impreso el reporte final.`;

const input = JSON.stringify({
  message: prompt,
  permission_mode: 'acceptEdits',
  max_turns: 30,
});

const result = db
  .prepare('UPDATE tasks SET input_json = ?, stage = ?, updated_at = ? WHERE id = ?')
  .run(input, 'playwright-headed-report', Date.now(), taskId);

console.log(`Updated task ${taskId} (changes=${result.changes})`);
db.close();
