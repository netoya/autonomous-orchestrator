# ADR-006: Controles de ciclo de vida — `flow cancel`, `waiter reject`, `task waiters` (audit)

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-20 |
| **Version spec** | v0.8.1 |
| **Autores** | Angel Oliver, Claude Opus 4.7 (1M context) |
| **Supersedes** | — |
| **Relacionado** | ADR-005 (roles del waiter) |

---

## Contexto

Tras validar el patrón nativo del waiter loop (ADR-005), el orquestador permite crear flows y resolver waiters, pero carece de tres operaciones de control imprescindibles para uso sostenido:

1. **No hay `flow cancel`**. Si un flow se desvía (idea mal interpretada, agente en loop interno, costo descontrolado), no hay forma limpia de detenerlo. El operador debe matar procesos `claude -p` a mano, dejar tasks en `running`/`waiting-waiter` que el recovery resetea a `ready` indefinidamente, y borrar manualmente entradas en la DB — violando el principio "no editar SQLite a mano".

2. **No hay `waiter reject`**. La única forma de "rechazar" un waiter pasivo hoy es `fulfill` con un payload que el callback `onValid` interprete como rechazo (ej. `{decision: "rejected"}`). Esto requiere convención implícita entre el creador del waiter y el operador, no escalable.

3. **No hay forma de auditar el diálogo waiter↔operador por task**. El history vive en la tabla `waiters` pero no se expone por CLI. Para entender qué respuestas dio el operador en un planner-mode iterativo (ronda 1, ronda 2, etc.), hay que hacer `sqlite3` manual a la DB.

### Restricciones aplicables

- **Principio 1.7 (observador/observado)**: el agente declara waiters; el dispatcher reacciona. El operador interrumpe a través de comandos CLI explícitos, no editando estado.
- **Principio "no editar SQLite a mano"** (guía operativa): toda transición de estado pasa por el motor.
- **Compatibilidad con ADR-005**: las nuevas operaciones deben respetar el modelo de 4 cuadrantes (modo × rol) sin introducir estados intermedios.

### Sub-decisiones identificadas

Cada feature tiene decisiones de diseño no triviales:

#### Para `flow cancel`

| Decisión | Opciones |
|---|---|
| **Alcance del cascade** | (a) solo flow, dejar tasks en su estado actual. (b) flow + tasks no-terminales → `cancelled`. (c) flow + tasks + waiters pendientes → `cancelled`. |
| **Procesos vivos** | (a) confiar en que el agente termine por timeout. (b) matar `claude -p` asociados via `childPids` set. |
| **Idempotencia** | ¿Qué pasa si se cancela un flow ya `completed`? Error o no-op silencioso. |

#### Para `waiter reject`

| Decisión | Opciones |
|---|---|
| **Estado de la task asociada** | (a) task → `cancelled` (no reanuda). (b) task → `ready` y reanuda con `value_json={_rejected:true}` para que el agente decida. (c) parametrizar con flag `--cascade-task`. |
| **Evento emitido** | (a) `waiter.rejected` nuevo. (b) reutilizar `waiter.fulfilled` con marca en payload. |
| **Convención de `value_json`** | (a) vacío. (b) `{_rejected: true, reason: "..."}`. (c) custom según schema. |

#### Para `task waiters`

| Decisión | Opciones |
|---|---|
| **Formato default** | (a) table ANSI. (b) json. (c) jsonl. |
| **Qué incluye** | Mínimo: step_id, kind, mode, status, created_at, value_json. ¿Schema_json? ¿Authz_json? |
| **Filtros** | (a) solo `waiting`. (b) todos. (c) flag `--status`. |
| **Output programático** | ¿Flag `--json` para consumir desde otras herramientas (visor)? |

---

## Decisión

### A — `flow cancel <flow-id> [--reason "..."]`

**Cascade completo, mata procesos, idempotente.**

- Marca `flow.status='cancelled'`.
- Marca TODAS las tasks no-terminales (`queued|ready|running|waiting-waiter`) como `cancelled`. Las terminales (`done|failed|cancelled`) se respetan.
- Marca TODOS los waiters `waiting` del flow como `cancelled` (status nuevo, requiere ALTER del CHECK constraint).
- Mata `claude -p` hijos cuyas `task_id` están en el flow (via `childPids` Set + tabla `executions`).
- Emite `flow.cancelled` con payload `{flow_id, reason?, cancelled_tasks: [...], cancelled_waiters: [...]}`.
- **Idempotente**: si flow ya está en estado terminal, no-op + warning a stdout. Exit 0.
- Razón documentada en `events.jsonl` para auditoría.

#### Casos de uso reales

1. **El agente desvió la idea**. El operador pidió "mejorar admin" y el planner interpretó "rehacer auth desde cero" creando tasks de impl con tokens caros. Cancel + redefinir la idea con más precisión. *Ahorro: detiene el sangrado de tokens en segundos.*

2. **Cliente cambia scope mid-demo**. Durante un flow de demo en vivo, el cliente decide otra dirección. `flow cancel <id> --reason "cliente pidió pivot a X"` y se lanza un flow nuevo. El histórico queda documentado.

3. **Tras un fix del orchestrator, flows pre-fix quedan colgados**. Lo vivimos hoy: el fix de `dispatcher.ts:1082+` dejó tasks viejas en `waiting-waiter` indefinidas. `flow cancel` masivo limpia el ruido.

4. **Costo overrun (presupuesto diario superado)**. El operador detecta que `budget show` está a 95%. `flow cancel` de todos los `running` para parar gasto inmediato.

5. **Tests E2E que dejan flows huérfanos**. Lo vimos hoy: los tests Playwright del visor lanzaron 4 flows reales (planner mode), 3 fallaron, todos quedaron `running` por horas. `flow cancel` en `afterAll` del test los limpia.

6. **`waiter reject` cascada manual**. El operador rechaza un waiter clave, decide que el flow entero ya no aplica, `flow cancel` lo cierra completo.

### B — `waiter reject <waiter-id> --reason "..."`

**Task asociada NO reanuda, va a `cancelled`. Razón obligatoria.**

- Marca `waiter.status='rejected'` (estado ya existente en el CHECK del schema).
- Escribe `waiter.value_json={_rejected: true, reason: "..."}` por convención.
- Emite evento NUEVO `waiter.rejected` (distinto de `waiter.fulfilled`) con payload `{waiter_id, task_id, flow_id, reason}`.
- **Task asociada → `cancelled`** (no se reanuda). Justificación:
  - "Reject" semánticamente significa "no quiero continuar por este camino", incompatible con reanudar.
  - Si el operador quiere "respuesta distinta a la del schema", tiene 2 alternativas legítimas:
    - `fulfill` con payload custom que el callback `onValid` sepa manejar.
    - Cancelar y relanzar con la idea ajustada (escape hatch del visor `Respond differently` ya implementa esto).
  - Hacer reject = "reanuda con marca _rejected" complica la API del waiter (cada agente tiene que aprender a leer `_rejected` o falla).
- **`--reason` obligatorio**: previene rejects sin contexto que confunden al auditor del log.
- Idempotente: rechazar un waiter ya en estado terminal → no-op + warning.

#### Casos de uso reales

1. **Ninguna opción del schema aplica**. El planner generó 4 enums (`area: [admin, embed, api, infra]`) pero el operador quiere atacar algo transversal. En el visor usa "Respond differently"; en CLI usa `waiter reject ... --reason "ninguna área encaja, replantear"`.

2. **Premisa del agente equivocada**. Tras leer el `PLAN-PROPOSAL.md`, el operador detecta que Roman entendió mal el contexto (ej: confundió Geolinks con Kunfupay-Nextjs). Reject con motivo "premisa falsa, voy a relanzar con contexto explícito" → task cancelled, flow puede ser cancelado a continuación o el operador relanza el coordinate con prompt corregido.

3. **Aprobación de arquitectura bloqueada por compliance**. Un waiter pide "aprobar diseño antes de implementar"; el operador descubre que falta firma legal. `waiter reject --reason "esperando feedback de legal, revisión bloqueada hasta DD-MM"` deja huella en `events.jsonl`. El flow puede revivirse con un nuevo flow cuando llegue legal.

4. **Deploy a producción gated, regresiones detectadas en QA**. Waiter `approve-prod-deploy` esperando OK del operador. QA reporta bugs en últimas horas. Reject con motivo "bugs detectados en regression-test #1234, no deployar". El equipo recibe el evento, el flow no avanza, no se rompe prod.

5. **Cambio de prioridad en planner-mode iterativo**. Llevas 2 rondas con Roman acotando una feature; en R3 el operador decide que ya no es la prioridad del sprint. Reject el waiter R3 con motivo "pivot a feature Y" → task cancelled, sin gastar más turnos del planner.

6. **Auditoría obliga motivo**: el equipo de seguridad requiere que cualquier rechazo de gate quede registrado con razón. El `--reason` obligatorio + el evento `waiter.rejected` en `events.jsonl` lo entregan listo.

### C — `task waiters <task-id> [--status <s>] [--json]`

**Audit trail readonly de los waiters asociados a una task.**

- Default: tabla ANSI con columnas `step_id | kind | mode | status | created_at | value_json (truncado)`.
- `--json`: array JSON estructurado con TODOS los campos (incluido `schema_json`, `prompt`, `value_json` completo) para consumo programático.
- `--status <s>`: filtro por `waiting|fulfilled|rejected|timeout|invalid|cancelled` (combinable múltiples veces).
- Orden: `created_at ASC` (cronológico, refleja el diálogo).
- Si task no existe → exit 1 con error.
- Si task no tiene waiters → exit 0 con mensaje "no waiters for task <id>".

#### Casos de uso reales

1. **Onboarding de nuevo operador**. Persona nueva entra al equipo, hereda un flow en curso. `task waiters <id>` muestra el diálogo completo entre el agente y el operador anterior (qué preguntó, qué respondió) — entiende el contexto sin pedir explicación.

2. **Debugging post-mortem de flow fallido**. Un flow falló en medio. ¿En qué ronda pasó? ¿Qué se respondió antes del fallo? `task waiters <task-id>` reconstruye el camino: R1 fulfilled→R2 fulfilled→R3 timeout = ah, expiró un waiter sin respuesta.

3. **Audit de compliance**. Equipo de seguridad pide ver qué decisiones humanas se tomaron en qué punto y por qué (gates con `--reason`). `task waiters --json` exporta el historial completo para herramienta externa (Excel, dashboard, BI). Cada `value_json` y `_rejected.reason` queda trazable.

4. **UX en el visor**. Drawer de task tiene sección "Waiter history" con timeline. Operador ve el diálogo completo sin abrir 5 pestañas SQL. Habilita lo que el spec del visor v1.1 propondrá (§Compatibilidad abajo).

5. **Métrica de calidad del planner**. ¿Cuántas rondas suele necesitar un planner-mode? Agregando `task waiters --json | jq 'length'` sobre los planner-flows del último mes, sale el promedio. Si es alto (>5), señal de que los prompts del planner deben mejorar.

6. **Reproducir un escenario en otro entorno**. Operador quiere replay un flow en staging: extrae `task waiters --json`, monta un mock que devuelva esas mismas respuestas, lanza el flow en staging. Habilita testing determinista de planners.

7. **Verificar el "diálogo" antes de cancelar**. Antes de `flow cancel`, el operador hace `task waiters` para ver si las respuestas que dio están bien — quizás solo le falta una y conviene fulfill un waiter más en lugar de cancelar todo.

### Cambio de schema requerido

`waiters.status CHECK` actualmente incluye: `waiting | fulfilled | rejected | timeout | invalid`. Para soportar `flow cancel` con cascade a waiters, se añade `cancelled`. Migración:

```sql
-- migration 007_waiter_cancelled_status.sql
-- SQLite no permite ALTER del CHECK constraint directamente.
-- Patrón: crear tabla nueva con el CHECK ampliado, copiar datos, drop la vieja.
-- (Implementación detallada en el flow de impl.)
```

### Estructura del DAO (nuevo)

```ts
// src/db/dao/flows.ts
export function cancelFlow(db, flowId, opts: { reason?: string }): {
  flow_cancelled: boolean;
  cancelled_tasks: string[];
  cancelled_waiters: string[];
};

// src/db/dao/waiters.ts
export function rejectWaiter(db, waiterId, opts: { reason: string }): WaiterRow;
export function listWaitersForTask(db, taskId): WaiterRow[];
```

---

## Consecuencias

### Positivas

1. **Cierra el ciclo operativo**: el operador puede crear → resolver → **cancelar / rechazar** → auditar, sin tocar SQLite a mano.
2. **Reduce gasto en runaway**: cancelar un flow descontrolado mata procesos `claude` vivos en segundos.
3. **Habilita features del visor**: la tab Waiters puede mostrar history por task usando `listWaitersForTask`. El drawer puede ofrecer botón "Reject" cuando aplique.
4. **Mejora la auditoría**: `events.jsonl` registra `flow.cancelled` y `waiter.rejected` con razón obligatoria — trazabilidad de decisiones operativas.
5. **Compatibilidad con ADR-005**: las nuevas operaciones respetan el modelo 2×2 sin introducir estados intermedios. Una task cancelada SÍ tiene waiters fulfilled/rejected en su historial, consultables vía `task waiters`.

### Negativas

1. **Migración del CHECK constraint de `waiters.status`**: requiere recrear la tabla en SQLite. Mitigación: migración estándar (007) con copy + drop, rollback documentado.
2. **Decisión "reject → task cancelled" es opinionada**. Si en el futuro se quiere "reject con reanudación", requeriría un flag adicional (`--cascade-task=cancel|continue`). Aceptable porque la opción A es la semántica natural.
3. **`waiter.rejected` es un evento nuevo**: consumidores (visor, scripts custom) deben actualizarse para reconocerlo. Mitigación: el evento legacy `waiter.fulfilled` NO se reutiliza, así los consumidores que solo escuchan `fulfilled` simplemente ignoran los rechazos.
4. **Sin auditoría de quién canceló/rechazó**: hoy no hay sistema de usuarios. `events.jsonl` solo registra `reason`. Mitigación: aceptable en v0.9, futuro `--by <operator-id>` cuando exista auth.

### Neutras

- `task waiters` es solo lectura — no agrega gasto de tokens ni complica el modelo.
- `flow cancel` no toca `events.jsonl` viejo del flow — historial preservado.

---

## Alternativas consideradas

| Alternativa | Por qué se rechazó |
|---|---|
| **Reject = fulfill con `{_rejected:true}` + task reanuda** | Cada agente debe aprender la convención. Si no la respeta, ignora el rechazo y procede igual. Demasiado frágil. Decisión: reject = ruta independiente con semántica clara (task cancelled). |
| **Cancel sin cascade a waiters** | Deja waiters huérfanos en `waiting` que polueden tab del visor y disparan recovery confuso. Mejor cascada total. |
| **`task waiters` solo via DB query directa** | Acopla el visor + scripts custom a la estructura de la tabla. Romper esa abstracción tiene coste a futuro. CLI + DAO es la abstracción correcta. |
| **Añadir `flow pause` / `flow resume`** | Complejidad mucho mayor (pausar un flow en medio requiere serializar estado del agente, no solo del dispatcher). Out of scope v0.9. |

---

## Plan de implementación (resumen)

Orden sugerido (1 task por item, encadenadas):

1. **plan-v09**: review final del ADR + decisiones sub-óptimas (lucas como UX para `task waiters` output, roman para el resto).
2. **migration-007**: nueva migration SQL que añade `cancelled` al CHECK constraint de `waiters.status`. Test de roll-forward + manual rollback.
3. **dao-cancel**: `cancelFlow` en `flows.ts` (transacción atómica). Tests unitarios.
4. **dao-reject-audit**: `rejectWaiter` + `listWaitersForTask` en `waiters.ts`. Tests unitarios.
5. **dispatcher-cancel-events**: handler `flow.cancelled` que mata `childPids` filtrados por flow_id + handler `waiter.rejected` que transitiona task a `cancelled`.
6. **cli-flow-cancel**: subcomando `npx orchestrator flow cancel <id>`. Smoke test.
7. **cli-waiter-reject**: subcomando `npx orchestrator waiter reject <id> --reason "..."`. Smoke test.
8. **cli-task-waiters**: subcomando `npx orchestrator task waiters <id> [--status] [--json]`. Snapshot test del output.
9. **smoke-e2e**: test end-to-end: crear flow → fulfill un waiter → reject otro → cancel el flow → audit con `task waiters` mostrando todo el historial.
10. **doc-update**: README + docs/guides/operating-the-orchestrator.md con las 3 nuevas operaciones.
11. **final-v09-report**: dante escribe v09-report con summary, archivos editados, recomendación de v1.0.

Estimado: **~3-4 horas** del orchestrator (~5h secuencial). Bucle verify-repair de 2 vueltas.

---

## Test plan E2E

```bash
# 1. Setup: flow con un planner-mode iterativo (de ADR-005)
FLOW_ID=$(npx orchestrator coordinate "<prompt planner>" | grep -oE '01K[A-Z0-9]+' | head -1)

# 2. Espera a que cree waiter R1
# (polling o sleep)

# 3. Audit antes de tocar nada
npx orchestrator task waiters <task-id>
# expected: 1 row, status=waiting

# 4. Fulfill R1
npx orchestrator waiter fulfill <waiter-r1-id> --json '{"area":"admin"}'

# 5. Espera R2
# 6. Reject R2 (decisión operativa: ya no quiero este flow)
npx orchestrator waiter reject <waiter-r2-id> --reason "scope expanded, redoing from scratch"

# 7. Verifica que task asociada → cancelled
sqlite3 state/orchestrator.db "SELECT status FROM tasks WHERE flow_id='$FLOW_ID';"
# expected: cancelled (porque waiter rejected)

# 8. Cancel del flow entero (idempotente con el reject anterior)
npx orchestrator flow cancel $FLOW_ID --reason "cleanup tras reject"

# 9. Audit final
npx orchestrator task waiters <task-id> --json
# expected: 2 waiters, r1=fulfilled, r2=rejected, ambos con value_json visible

# 10. Verifica que no quedan procesos claude -p del flow
ps aux | grep "claude -p" | grep "$FLOW_ID"
# expected: vacío
```

---

## Compatibilidad con visor v1

Una vez `listWaitersForTask` exista, el spec del visor (`visor-orchestrator/docs/specs/v1-write-operations.md`) puede extenderse en v1.1:

- **Drawer de task**: sección "Waiter history" con tabla cronológica.
- **Drawer de waiter**: botón `Reject with reason` ya documentado (§4.1) ahora tiene endpoint real → `POST /api/waiters/:id/reject` que spawnea `npx orchestrator waiter reject`.
- **Tab Flows**: botón `Cancel flow` en flows `running` → `POST /api/flows/:id/cancel` que spawnea `npx orchestrator flow cancel`.

Estas extensiones del visor son **out-of-scope de este ADR** (van a un v1.1 del visor), pero el ADR-006 las habilita.

---

## Referencias

- **Spec sección 3.3** (Waiters): estados, modos.
- **Spec sección 3.5** (Cancellation): mencionado como out-of-scope MVP, este ADR lo cierra.
- **ADR-005**: roles del waiter (pre-cond vs suspend/resume). Este ADR respeta el modelo.
- **`docs/guides/operating-the-orchestrator.md`**: operación día a día — se actualizará tras implementación.
- **Spec consumidor externo**: `visor-orchestrator/docs/specs/v1-write-operations.md` §4 — Reject button condicional, compatible con esta decisión.

---

**Firmado**: Angel Oliver, Claude Opus 4.7 (1M context), 2026-05-20  
**Aprobado por**: pendiente (este ADR está en Draft hasta tu OK explícito)
