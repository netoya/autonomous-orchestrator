# ADR-008: `approve-plan` waiter — confirm/reject del plan via fulfill (no botón efímero)

| | |
|---|---|
| **Status** | Accepted |
| **Fecha** | 2026-05-20 |
| **Version spec** | v0.8.2 |
| **Autores** | Angel Oliver, Claude Opus 4.7 (1M context) |
| **Supersedes** | — |
| **Relacionado** | ADR-005 (waiter roles), ADR-007 (plan confirm/execute) |

---

## Contexto

ADR-007 introdujo `flow confirm <prepareFlowId>`: dado un flow planner cuyo `PLAN-FINAL-<flowId>.md` está en `Status: PLAN_READY`, el CLI valida y lanza un flow ejecutor con `parent_flow_id`. El visor expone esto como botón "Confirm" en la tab Coordinate.

**Problema:** el botón Confirm es **efímero**. Vive solo en el estado de la UI mientras la pestaña Coordinate está abierta y el polling `/api/flows/:id/prepare-state` activo. Si el operador:

- cierra la pestaña,
- cambia a otra tab (Flows / Waiters / Stats),
- recarga el navegador,
- o intenta confirmar desde otro dispositivo,

**pierde el acceso al confirm**. El plan sigue en disco, el flow sigue `completed`, pero no hay UI que ofrezca el botón hasta que vuelva a Coordinate y la app reconstruya el estado desde polling. Y los "Recent prepares" hoy no son clickables.

Esto contradice un principio del visor: **cualquier paso que requiera input humano debería ser un waiter persistente**, no un estado in-memory. Los waiters:

- aparecen en el banner global `waiters: N`,
- son fulfilable desde la tab Waiters (drawer dedicado),
- registran auditoría (quién/cuándo/qué payload),
- sobreviven a refresh / cierre / cambio de dispositivo,
- y reusan toda la infraestructura existente (fulfill, reject, schema, lifecycle).

### Opciones evaluadas

| Opción | Pros | Contras |
|---|---|---|
| **A: Status quo (botón efímero en UI)** | Cero cambios. | Confirm se pierde fuera de Coordinate. Inconsistente con el patrón "input humano = waiter". |
| **B: Hacer clickables los Recent prepares** | Pequeño cambio frontend. | No resuelve la asimetría conceptual. Sigue siendo botón en UI, no entidad de dominio. |
| **C: `approve-plan` waiter (este ADR)** | Confirm es entidad persistente, auditable, ubicua. Reusa fulfill/reject. Reject del waiter = cancelar plan (alinea con ADR-006). | Cambio al prompt del planner. Handler nuevo en dispatcher. Ajuste a CoordinateTab. ~150 líneas. |

### Restricciones aplicables

- **No romper backwards compat**: flows ya `completed` con `PLAN-FINAL-*.md` existentes deben seguir confirmables vía CLI `flow confirm` directo.
- **Sin acoplar dispatcher a la lógica de visor**: el handler del dispatcher spawnea `npx orchestrator flow confirm` (consistente con ADR-007), no llama DAO directo.

---

## Decisión

**Adoptar opción C.** Tres cambios atómicos:

### 1. Roman crea un último waiter `approve-plan` al terminar PLAN_READY

En lugar de terminar la task `planner-analyze` con status `done` tras escribir `PLAN-FINAL-<flowId>.md`, Roman crea un waiter pasivo final:

- `kind`: `approve-plan`
- `schema_json`: `{"type": "object", "properties": {"action": {"type": "string", "enum": ["confirm", "reject"]}, "notes": {"type": "string"}}, "required": ["action"]}`
- `prompt`: `"Plan PLAN_READY. Confirmar para arrancar flow ejecutor, o reject para cancelar."`

La task queda en `waiting-waiter` (no `done`). El flow queda `running` (no `completed`). Esto desbloquea el flujo nativo de waiters: aparece en banner, drawer, etc.

### 2. Dispatcher: handler para `waiter.fulfilled` con `kind='approve-plan'`

Cuando el dispatcher consume `waiter.fulfilled` y el waiter es `approve-plan`, parsea `value_json.action`:

- `action='confirm'` → spawn `npx orchestrator flow confirm <flow_id>` (CLI existente de ADR-007).
- `action='reject'` → spawn `npx orchestrator flow cancel <flow_id> --reason "rejected by operator: ${notes ?? ''}"`.

El handler es fire-and-forget; el resultado del confirm (flow ejecutor creado) llega vía eventos normales del dispatcher. No bloquea el tick.

### 3. Visor: `prepare-state` y `CoordinateTab` reconocen `approve-plan`

- **Backend** (`server/index.ts` `/api/flows/:id/prepare-state`): si el flow tiene un waiter pasivo `kind='approve-plan'` en `waiting`, retornar `state: 'proposal-ready'` con `waiter` poblado (no `blocked-by-waiter` genérico). Esto permite que la UI muestre el plan + botones específicos en vez del SchemaForm genérico.
- **Frontend** (`CoordinateTab.js`): cuando `state === 'proposal-ready'` y `waiter` existe, los botones Confirm/Reject del plan llaman `POST /api/waiters/:id/fulfill` con `{action: 'confirm'}` o `{action: 'reject', notes}`. El endpoint legacy `POST /api/flows/confirm` queda como atajo backwards-compat (CLI directo, lifecycle pre-ADR-008).

---

## Consecuencias

### Positivas

- **Persistencia**: el confirm sobrevive a refresh / cambio de pestaña / cierre del navegador / otro dispositivo.
- **Visibilidad global**: el banner `waiters: N` cuenta el approve-plan, así el operador sabe que tiene una decisión pendiente sin estar en Coordinate.
- **Auditoría**: `fulfilled_by`, `fulfilled_at`, `value_json` de la tabla waiters registra quién confirmó/rechazó y con qué notas.
- **Reuso**: drawer de waiters, fulfill, reject, lifecycle (ADR-006) — todo aplica sin cambios.
- **Alineamiento conceptual**: cualquier acción humana sobre un flow pasa por waiter. Sin excepciones de UI.

### Negativas / costo

- El prompt de Roman gana ~10 líneas (crear el waiter final). `planner-mode.md` se actualiza.
- Handler nuevo en `dispatcher.handleWaiterFulfilled` con `~30` líneas y test asociado.
- El backend del visor distingue `kind='approve-plan'` en el endpoint `prepare-state` (~15 líneas).
- Frontend ajusta acción de botones Confirm/Reject (de POST `/api/flows/confirm` a POST `/api/waiters/:id/fulfill`).

### Riesgos

- **Doble confirmación**: si el operador fulfill desde drawer Y desde Coordinate al mismo tiempo, el segundo intento devuelve 409 `already fulfilled`. La UI absorbe ese error (silencioso o info banner). Aceptable.
- **Reject + dispatcher race**: el handler spawnea `flow cancel`. Si ya estaba cancelado por otra ruta, el CLI es idempotente (ADR-006 `already_terminal=true`). Aceptable.
- **kind nuevo en check constraint**: la tabla `waiters` tiene `kind TEXT NOT NULL` sin CHECK constraint sobre valores específicos. No requiere migración.

---

## Implementación

| Archivo | Cambio | Líneas estimadas |
|---|---|---|
| `docs/planner-mode.md` | Añadir paso final "crear waiter approve-plan" en ambos caminos (A y B) | +30 |
| `src/dispatcher.ts` | Handler `approve-plan` en `handleWaiterFulfilled` | +35 |
| `visor-orchestrator/server/index.ts` | Branch en `prepare-state` para `kind='approve-plan'` → `proposal-ready` | +15 |
| `visor-orchestrator/src/components/tabs/CoordinateTab.js` | Confirm/Reject buttons llaman fulfill en lugar de `/api/flows/confirm` | +25 |
| Tests | dispatcher handler + e2e prepare-state | +50 |

**Total estimado**: ~155 líneas. Una iteración (~1-2h).

---

## Plan de rollout

1. ADR-008 escrito y aceptado.
2. Actualizar `planner-mode.md` con el paso del waiter approve-plan.
3. Implementar handler en dispatcher.
4. Ajustar `prepare-state` del visor.
5. Ajustar `CoordinateTab.js` para fulfill en lugar de endpoint legacy.
6. E2E test: crear flow planner sin ambigüedades → verificar que aparece waiter `approve-plan` → fulfill `{action:'confirm'}` → verificar que se crea flow ejecutor con `parent_flow_id`.

Backwards-compat: `POST /api/flows/confirm` y el CLI `flow confirm` siguen disponibles para flows pre-ADR-008 (sin waiter approve-plan).
