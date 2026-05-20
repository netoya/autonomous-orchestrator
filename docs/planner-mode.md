# Planner mode

Modo de operacion del `flow-coordinator` que NO descompone la idea del operador
en tasks ejecutables (impl/test/verify/etc), sino que actua como **planner
estatico**: inspecciona, detecta ambiguedades, levanta un waiter pasivo si hace
falta, y deja un documento de plan en `state/conversations/` para que el
operador confirme antes de pasar a ejecucion.

Validado end-to-end el 2026-05-20 con dos flows reales:

- Flow `01KS2G8W4G9D0GTQT4GSVNAN9Y` — planner detecto 4 ambiguedades sobre la
  idea `orchestrator status <flow-id>`, creo waiter
  `01KS2GAH0V11YK3SSHSZK48MJX` y produjo `EXPERIMENT-PLAN-PROPOSAL.md`
  (status `BLOCKED-BY-WAITER`).
- Flow de re-plan — tras fulfill del waiter con
  `{repo, command_shape, format, include}`, produjo `EXPERIMENT-PLAN-FINAL.md`
  (status `PLAN_READY`).

---

## Comportamiento

El coordinator-seed, cuando recibe un prompt en modo planner, hace estrictamente
estos pasos:

1. **Lee codebase + idea del operador.** Inspeccion minima orientada a detectar
   ambiguedades (no lectura exhaustiva).
2. **Detecta ambiguedades** sobre repo destino, forma del comando/feature,
   formato de salida, entidades incluidas, cualquier otra decision de diseño
   sin respuesta unica.
3. **Si hay ambiguedades:** crea **UN solo** waiter pasivo `kind=clarification`
   con `schema_json` enumerando las preguntas como JSON Schema (object con
   properties enum + required). El operador responde via `fulfillWaiter` con un
   JSON que matchea el schema.
4. **Escribe `PLAN-PROPOSAL-<flowId>.md`** en `state/conversations/` (caso
   ambiguedad, status `BLOCKED-BY-WAITER`) o **`PLAN-FINAL-<flowId>.md`** (caso
   resolved, status `PLAN_READY`) con resumen ejecutivo, archivos a tocar,
   estructura del comando, logica paso a paso, tests sugeridos y riesgos.

   **IMPORTANTE — convención de filename desde ADR-007**: el archivo DEBE
   incluir el flowId para evitar race conditions entre flows paralelos. Los
   paths legacy `PLAN-PROPOSAL.md` / `PLAN-FINAL.md` (sin flowId) están
   deprecados pero soportados por `flow confirm` como fallback retrocompatible.

   Para obtener tu flowId desde dentro del agente:
   ```bash
   sqlite3 state/orchestrator.db \
     'SELECT flow_id FROM tasks WHERE stage = "planner-analyze" ORDER BY created_at DESC LIMIT 1'
   ```

5. **NO crea mas tasks.** El planner deja el flow en estado terminal con un
   solo entregable: el doc. Es el operador quien decide si lanza un flow nuevo
   de implementacion (via `npx orchestrator flow confirm <flowId>` o el visor).

---

## Prompt template (al coordinator-seed)

Variables a interpolar:

- `{idea}` — idea cruda del operador, en lenguaje natural.
- `{answers?}` — opcional, JSON con las respuestas del waiter previo si esta
  iteracion es un re-plan.
- `{previousFlowId?}` — opcional, flow id de la iteracion anterior (chain).

### Iteracion 1 — planner inicial (sin answers)

```
PLANNER MODE — Analizar idea del operador. NO crear plan ejecutable.

REGLAS CRITICAS:
- NO crees tasks de impl/test/verify/etc. NO descompongas la idea en plan ejecutable.
- Crea EXACTAMENTE 1 task: slug planner-analyze, agente softwarefactory_roman.
- Esa task hace TODO el planner-work: lee codebase, escribe doc, crea waiter si hace falta.
- Tras crear la task, emite <<COORDINATOR_DONE: planner-analyze task created>>. NADA mas.

IDEA del operador:
"{idea}"

---

DESCOMPON en exactamente 1 task. Slug literal:

------------------------------------------------------------
Slug: planner-analyze — agente: softwarefactory_roman
--cwd <project-root>
[--add-dir <otro-repo-relevante>]
--priority 10 --max-turns 80 --estimated-minutes 25
Sin depends-on.

PROMPT:
"Eres PLANNER MODE — no executor. Tu trabajo:
1. Inspecciona brevemente la idea del operador y el codebase relevante.
   - Lee los archivos clave para conocer la estructura actual.
   - NO leas exhaustivamente — solo lo necesario para identificar ambiguedades.

2. IDEA del operador:
   '{idea}'

3. Analiza si la idea tiene AMBIGUEDAD. Preguntas tipicas (adaptar al dominio):
   - ¿En que repo va el cambio?
   - ¿Que formato de salida default?
   - ¿Que entidades / endpoints / archivos tocar?
   - Cualquier otra ambiguedad que detectes.

4. DOS caminos:

   CAMINO A — Si SIN ambiguedad:
   - Write a <project-root>/state/conversations/PLAN-PROPOSAL.md con:
     - Status: PLAN_READY
     - Resumen ejecutivo (5-8 lineas)
     - Repo destino + archivos exactos a tocar
     - Forma del entregable (args, flags, output)
     - Tests sugeridos
   - Termina con mensaje 'PLAN_READY — pronto para confirmacion del operador'.

   CAMINO B — Si CON ambiguedad (esperado):
   - Crea UN waiter pasivo con Bash:
       npx tsx <orchestrator-root>/src/coordinator/cli-tools.ts createWaiter \\
         --flow-id $FLOW_ID \\
         --task-slug planner-analyze \\
         --step-id clarification-1 \\
         --kind clarification \\
         --prompt 'Necesito que aclares estos puntos antes de proponer plan firme. Responde el JSON con tus elecciones.' \\
         --schema-json '<JSON SCHEMA con las preguntas>' \\
         --timeout-ms 86400000

     El JSON Schema debe tener properties con enums + required apropiado.

   - Captura el waiter_id devuelto por el comando.

   - Write a <project-root>/state/conversations/PLAN-PROPOSAL.md con:
     - Status: BLOCKED-BY-WAITER
     - waiter_id: <el id capturado>
     - Lista en lenguaje natural de las preguntas (para que el operador entienda sin parsear el JSON Schema).
     - Resumen tentativo de lo que el planner haria si tuviera las respuestas (1 parrafo).
   - Termina con mensaje 'PLAN_BLOCKED — esperando respuesta del operador al waiter <id>'.

5. NUNCA crear mas de 1 waiter. NUNCA crear tasks adicionales. NUNCA implementar nada.

Para conocer tu propio FLOW_ID: $FLOW_ID viene en el env del agent runner.
Si no esta, consulta la DB:
  cd <orchestrator-root> && sqlite3 state/orchestrator.db \\
    'SELECT flow_id FROM tasks WHERE id = (SELECT id FROM tasks WHERE stage = \"planner-analyze\" ORDER BY created_at DESC LIMIT 1);'
"

------------------------------------------------------------

Cuando termines de crear la task: <<COORDINATOR_DONE: 1 task creada para planner-mode>>
```

### Iteracion 2 — re-planner con answers (chain)

```
PLANNER MODE — Re-plan con respuestas del waiter.

CONTEXTO: en flow previo ({previousFlowId}) el planner identifico ambiguedades y creo waiter. El operador ya respondio:

{answers}

REGLAS CRITICAS:
- NO crees tasks de impl/test/verify.
- Crea EXACTAMENTE 1 task: slug planner-finalize, agente softwarefactory_roman.
- Esa task produce PLAN-FINAL.md con plan firme. NO crea mas waiters.
- Emite <<COORDINATOR_DONE: planner-finalize task created>>.

IDEA ORIGINAL:
"{idea}"

DECISIONES YA RESUELTAS:
{answers expandidas en bullets}

---

DESCOMPON en 1 task. Slug literal:

------------------------------------------------------------
Slug: planner-finalize — agente: softwarefactory_roman
--cwd <project-root>
--priority 10 --max-turns 80 --estimated-minutes 20
Sin depends-on.

PROMPT:
"Eres PLANNER MODE — generas plan firme tras clarificaciones. NO ejecutes.

Ya tienes las respuestas:
{answers expandidas}

Tu trabajo:
1. Lee los archivos relevantes para conocer el patron actual.

2. Escribe Write <project-root>/state/conversations/PLAN-FINAL.md con:

   ## Plan firme — <titulo>

   ### Status
   PLAN_READY — listo para confirmacion del operador.

   ### Decisiones (resueltas en waiter <waiter-id>)
   Tabla resumen de las elecciones.

   ### Archivos a crear / modificar
   - tabla con archivo, accion, proposito.

   ### Estructura
   - sintaxis, output, helpers.

   ### Logica
   - pasos numerados.

   ### Tests sugeridos
   - paths y asserts clave.

   ### Riesgos
   - tabla riesgo / mitigacion.

   ### Proximo paso
   Comando exacto para lanzar el flow de implementacion.

   ---
   PLAN_READY.

3. NO crear tasks adicionales. NO crear waiters. NO ejecutar nada.
4. Termina con: 'PLAN_READY — pronto para confirmacion'."

------------------------------------------------------------

Cuando termines: <<COORDINATOR_DONE: 1 task planner-finalize creada>>
```

---

## Convencion de archivos

Ambos docs se escriben en `state/conversations/` con un prefijo opcional que
identifica el lineage (ej: `EXPERIMENT-`, `<feature-name>-`).

| Archivo                   | Cuando                              | Frontmatter / primera linea       |
| ------------------------- | ----------------------------------- | --------------------------------- |
| `PLAN-PROPOSAL.md`        | Iteracion con ambiguedades          | `**Status:** BLOCKED-BY-WAITER`   |
| `PLAN-PROPOSAL.md`        | Iteracion sin ambiguedades          | `**Status:** PLAN_READY`          |
| `PLAN-FINAL.md`           | Tras fulfill del waiter (re-plan)   | `**Status:** PLAN_READY`          |

**Campos minimos que el consumidor parsea de los docs:**

- `Status:` — `BLOCKED-BY-WAITER` | `PLAN_READY` (case-sensitive).
- `Waiter ID:` (solo si BLOCKED-BY-WAITER) — ULID del waiter pasivo.
- `Flow ID:` — ULID del flow planner (presente en ambos casos).

Recomendacion: mantener estos tres campos como bullets `**Key:** value` en las
primeras 10 lineas del doc para que el parsing de los consumidores externos sea
trivial (regex sobre las primeras N lineas).

---

## Limites

- **Cap recomendado: 3 iteraciones por linaje.** Una idea ambigua se resuelve
  en 1-2 ciclos planner → waiter → re-planner. Si necesita mas, hay que pedir
  al operador que reformule la idea desde cero, no seguir encadenando waiters.
- **Una sola task por iteracion.** Slug literal:
  - Iteracion 1: `planner-analyze` (agente `softwarefactory_roman`).
  - Iteracion 2+: `planner-finalize` (agente `softwarefactory_roman`).
- **Un solo waiter por iteracion.** Si el planner detecta que necesita mas de
  un waiter, debe agrupar todas las preguntas en un unico `schema_json`.
- **Agente fijo: `softwarefactory_roman` (Tech Lead).** El rol esta optimizado
  para inspeccion arquitectonica y diseno de contratos — no para implementar.

---

## Integracion con consumidores externos

El planner-mode esta pensado para ser invocado desde herramientas externas
(p.ej. `visor-orchestrator` UI) que necesitan un ciclo de
"propuesta → confirmacion del operador → plan firme" antes de que el operador
apruebe la ejecucion.

### Invocacion

```bash
# Iteracion 1
npx orchestrator coordinate \
  --message-file /tmp/planner-prompt-iter1.txt \
  --name planner-<feature-slug>-iter1 \
  --cwd <project-root> \
  --autonomy L3 \
  --session-strategy flow-agent-task
```

Donde `/tmp/planner-prompt-iter1.txt` contiene el prompt template rendereado
con `{idea}`.

### Parseo del output

El consumidor debe:

1. **Pollear el flow** hasta que el coordinator-seed termine
   (`flows.status = 'done'` y task `planner-analyze` en `done`).
2. **Leer el doc** en `<project-root>/state/conversations/PLAN-PROPOSAL.md`.
3. **Extraer `Status:`** de las primeras lineas:
   - `BLOCKED-BY-WAITER` → extraer `Waiter ID`, presentar las preguntas al
     operador, recolectar respuestas, fulfill waiter con
     `npx tsx <orch-root>/src/coordinator/cli-tools.ts fulfillWaiter --waiter-id <id> --value-json '<json>'`.
   - `PLAN_READY` → presentar el plan al operador para confirmacion final.
4. **Si fulfill ocurrio**, lanzar iteracion 2 con prompt template rendereado
   con `{idea}`, `{answers}` (JSON exacto del fulfill) y `{previousFlowId}`.
5. **Loop con cap de 3 iteraciones.** Si la 3a iteracion aun esta
   `BLOCKED-BY-WAITER`, abortar y reportar al operador.

### Chaining entre iteraciones

El planner-mode NO usa `createFlow` para auto-encadenar la iteracion 2 (a
diferencia de los flows de implementacion). El consumidor externo es quien
decide si continua, porque la iteracion 2 requiere las respuestas del
operador — no son derivables por el coordinator.

Si en el futuro se quiere autoencadenamiento sin intervencion externa
(p.ej. para fulfills automaticos por CLI), seria necesario un `createFlow`
adicional dentro del prompt de `planner-analyze` condicionado al fulfill del
waiter, pero ese patron queda fuera de scope de este modo.

### Lifecycle resumido

```
operador ──idea──▶ visor ──spawn──▶ planner-mode-iter1
                                          │
                                          ├─ ambig? sí ─▶ waiter pasivo + PLAN-PROPOSAL.md (BLOCKED)
                                          │                         │
                                          │                  operador responde
                                          │                         │
                                          │             visor lanza planner-mode-iter2
                                          │                         │
                                          │                  PLAN-FINAL.md (PLAN_READY)
                                          │                         │
                                          │                  operador confirma
                                          │                         │
                                          │             visor lanza flow de impl real
                                          │
                                          └─ ambig? no ──▶ PLAN-PROPOSAL.md (PLAN_READY)
                                                                    │
                                                             operador confirma
                                                                    │
                                                      visor lanza flow de impl real
```
