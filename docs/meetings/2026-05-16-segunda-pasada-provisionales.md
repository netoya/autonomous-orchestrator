# Reunion: Segunda pasada (pulido + auditoria cruzada) de los provisionales Tier 1
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman, Mateo, Dante, Sofia
**Formato:** dos rondas — (1) auditoria cruzada, (2) cohesion final por Roman

## Contexto

Cerramos los 8 gaps Tier 1 en v0.8 con definiciones provisionales rapidas. Angel pide pulirlas antes de pasar a Tier 2, manteniendo el estatus provisional. Configuracion elegida:
- Pasada de pulido completa + auditoria cruzada.
- Roman hace pasada final de cohesion entre secciones.

Asignacion de auditoria cruzada (cada uno revisa lo de OTRO):

| Auditor | Audita |
|---|---|
| Mateo | 3.6.1 `TaskContext`, 3.6.2 `flow-coordinator` (de Roman) |
| Roman | 3.6.5 migraciones, 3.6.6 PRAGMAs (de Mateo) |
| Sofia | 3.6.3 DSL, 3.6.4 protocolo SQL (mixto) |
| Dante | 3.6.7 PM2 ecosystem (auto-auditoria desde lente operativa 24/7) |

## Resumen de hallazgos por seccion

### 3.6.1 TaskContext — auditado por Mateo
- **C1 [CRITICO]**: `ctx.log.info` apunta a tabla `executions.logs` que NO existe.
- **C2 [CRITICO]**: `WaiterResult` (tipo que retorna `ctx.wait`) NO esta definido en ningun lado.
- **C3 [CRITICO]**: Comportamiento de doble `ctx.complete()` / `ctx.fail()` indefinido.
- **C5 [CRITICO]**: `ctx.agent.run(): Promise<string>` inconsistente con `AgentRunResult` (sec 3.2.1). Flow no puede acceder a session_id ni cost.
- **C4 [IMPORTANTE]**: `ctx.artifacts.write()` concurrencia no especificada.
- **C6 [IMPORTANTE]**: Timeout de `ctx.wait()` sin documentar.
- **C7 [IMPORTANTE]**: `SubtaskPlan` tipo completamente ausente.

### 3.6.2 flow-coordinator — auditado por Mateo
- **C9 [CRITICO]**: Identificacion del coordinator ambigua (string matching vs permission flag) — contradice 1.7.3.
- **C10 [CRITICO]**: `dependsOn` sobre task ya `done` — ¿rechazo o `ready` directo?
- **C13 [CRITICO]**: ¿Coordinator puede crear waiters o solo tasks?
- **C11 [IMPORTANTE]**: Warning de doble invocacion no se persiste en ningun lado.
- **C12 [IMPORTANTE]**: CLI vs API programatica — ¿llaman al mismo codigo?

### 3.6.5 migraciones — auditado por Roman
- **C1 [CRITICO]**: Timing del INSERT a `schema_migrations` ambiguo.
- **C2 [CRITICO]**: Checksum alterado post-aplicacion debe fallar bloqueante.
- **C5 [CRITICO]**: Sin lock, dos `npm run migrate` simultaneos rompen todo.
- **C3 [IMPORTANTE]**: Triggers + `ALTER TABLE` posterior rompen silenciosamente.
- **C4 [IMPORTANTE]**: Forward-only friction para dev local — necesita `migrate:reset`.

### 3.6.6 PRAGMAs — auditado por Roman
- **C1 [CRITICO]**: PRAGMAs persistentes (WAL) vs per-connection (resto) no distinguidos.
- **C2 [CRITICO]**: Cambio DELETE → WAL requiere lock exclusivo — debe ir en migracion 000.
- **C3 [IMPORTANTE]**: `busy_timeout=5000` vs tick A de 500ms puede causar thread starvation.
- **C5 [IMPORTANTE]**: Scripts Bash con `sqlite3` CLI no heredan PRAGMAs — necesitan wrapper o `.sqliterc`.

### 3.6.3 DSL — auditado por Sofia
- **C2 [CRITICO]**: `loadSprint('/path/to/sprint.ts')` ejecuta TS arbitrario = remote code execution sin sandbox.
- **C3 [IMPORTANTE]**: Tests de tipos invalidos en campos validos no cubiertos.
- **C4 [IMPORTANTE]**: `dependsOn` + `dependsOnTag` combinacion ambigua.

### 3.6.4 protocolo SQL waiter-antes-de-task — auditado por Sofia
- **C1 [CRITICO]**: Crash post-COMMIT pre-spawn-checker deja waiters huerfanos. Recovery obligatorio al startup.
- **C4 [CRITICO]**: Falta test de race condition real con `BEGIN IMMEDIATE`.
- **C2 [IMPORTANTE]**: Cron de huerfanos cada hora demasiado lento — agregar check en startup.

### 3.6.7 PM2 — auto-auditado por Dante (lente operativa)
- **C1 [CRITICO]**: `max_restarts: 10` sin alertas — crash loop = muerte silenciosa.
- **C2 [CRITICO]**: `min_uptime: 10s` insuficiente — necesita `wait_ready: true` + `process.send('ready')`.
- **C4 [CRITICO]**: `max_memory_restart: 512M` arbitrario — necesita baseline real.
- **C3 [IMPORTANTE]**: `kill_timeout: 30000` vs `WAITER_EXEC_TIMEOUT_MS: 30000` colisionan.
- **C5 [IMPORTANTE]**: Logs sin rotacion crecen sin limite.
- **C6 [IMPORTANTE]**: Procedimiento de restart manual con drain no documentado.

## Resoluciones de Roman (Ronda 2 — cohesion final)

Roman resuelve **cada critico** con decision provisional v0.8.1 + detecta **4 contradicciones cross-section** que ningun auditor solo vio.

### Decisiones por gap

| Gap | Resolucion |
|---|---|
| **C1 (3.6.1)** | `ctx.log.*` escribe en `events.jsonl` con `event_type='log'` + `log_level`. La tabla `executions` NO tiene columna `logs`. Recuperacion via query a `events` filtrando por execution_id. |
| **C2 (3.6.1)** | `ctx.wait()` retorna `Promise<any>` (payload crudo que el waiter resolvio). `WaiterDecision` es interno del callback, no se expone al flow. |
| **C3 (3.6.1)** | Segunda llamada a `ctx.complete()` / `ctx.fail()` lanza `TaskAlreadyTerminated` y loguea warning. Dispatcher chequea `status IN ('done','failed')` antes de procesar. |
| **C5 (3.6.1)** | Dos metodos: `ctx.agent.run()` retorna `string` (output simple); `ctx.agent.runDetailed()` retorna `AgentRunResult` completo. Coordinator usa `runDetailed()` internamente siempre. |
| **C9 (3.6.2)** | Flag `role='coordinator'` en tabla `agents` (campo nuevo via migracion). El string matching `agentId === 'flow-coordinator'` es legacy y se elimina. |
| **C10 (3.6.2)** | Si A esta `done`, B con `dependsOn: ['A']` se crea directo como `ready`. Idempotente: mismo input → mismo estado inicial. |
| **C13 (3.6.2)** | Coordinator NO crea waiters. Solo tasks. Los waiters se crean implicitamente cuando una task ejecuta `ctx.wait()`. El artifact del coordinator solo serializa `tasks`. |
| **C1 (3.6.5)** | INSERT a `schema_migrations` ocurre DENTRO de la transaccion, DESPUES del ultimo statement. Si algo falla, todo revierte (incluyendo el insert). |
| **C2 (3.6.5)** | Checksum mismatch → `MigrationTamperedError`, NO arranca, requiere intervencion manual. Sin auto-fix. |
| **C5 (3.6.5)** | Filesystem lock: archivo `.migration.lock`. Si existe, espera 30 s y falla. Se borra al finalizar (exito o error). |
| **C1 (3.6.6)** | WAL es persistente, los demas PRAGMAs son per-connection. Init del DAO ejecuta TODOS en cada `new Database()`. Redundante para WAL pero asegura consistencia. |
| **C2 (3.6.6)** | `PRAGMA journal_mode=WAL` se ejecuta en migracion `000_init.sql`, NO en init del DAO. Garantiza que no haya conexiones competing al cambiar el modo. |
| **C2 (3.6.3)** | Aceptamos el riesgo en v0.8.1. Sprints son codigo trusted del equipo, no input externo. Documentar restriccion. v1.0 evalua sandbox (vm2 o Deno). |
| **C1 (3.6.4)** | Recovery al startup: query `SELECT * FROM waiters WHERE status='active' AND last_checked < NOW() - 60s`. Re-spawn de cada checker. Agregar campo `last_checked` a `waiters` (nueva migracion). |
| **C4 (3.6.4)** | Aceptamos no tener test de concurrencia real en v0.8.1. SQLite SERIALIZABLE + unit tests atomicos son suficiente. Sofia prioriza test de race condition para v0.9. |
| **C1 (3.6.7)** | Script `monitoring/check-restarts.sh` cada 5 min via cron. Si `pm2 jlist` reporta `restarts > 5`, alerta. No cambiamos `max_restarts` sin baseline. |
| **C2 (3.6.7)** | `min_uptime: 30000` (30 s) + `listen_timeout: 10000`. Dispatcher emite `process.send('ready')` tras init completo. PM2 espera la senal. |
| **C4 (3.6.7)** | Dante mide 48 h con carga simulada (100 tasks, 20 waiters concurrentes). P95 define baseline. 512M queda como placeholder hasta entonces (ticket `INFRA-102`). |

### Contradicciones cross-section que Roman detecto

1. **Waiter lifecycle vs recovery**: C13 dice que los waiters no estan en el artifact del coordinator (son runtime state), pero C1 de 3.6.4 necesita recovery al startup. **Resolucion**: los waiters SI estan persistidos en tabla `waiters` (recovery sirve), pero NO en el artifact JSON del flow (que es snapshot de tasks). Dos conceptos distintos de serializacion.

2. **`ctx.agent.run()` vs coordinator role**: C5 resuelto con `run()` simple para flows; pero un coordinator necesita saber si el sub-agente fallo para marcar la task como `failed`. **Resolucion**: el `flow-coordinator` siempre usa `runDetailed()` internamente. El `run()` simple es para flows de usuario.

3. **Migraciones + WAL + startup race**: ¿Que pasa si dos procesos arrancan simultaneos en DB virgen? **Resolucion**: el primero crea DB en DELETE, el segundo espera lock, cuando entra la DB ya esta en WAL. `PRAGMA journal_mode=WAL` es idempotente: re-ejecutarlo en WAL devuelve WAL sin error. Cohesion OK.

4. **Logs en events vs performance**: C1 de 3.6.1 dice logs van a `events.jsonl`. Si una execution tiene 50 tasks logueando 100 lineas cada una = 5000 filas. **Resolucion**: agregar indice compuesto `CREATE INDEX idx_events_logs ON events(execution_id, event_type, created_at)` en la migracion 002.

## Decisiones consolidadas

1. Spec pasa a **v0.8.1** (no v0.9 — sigue siendo provisional).
2. Las resoluciones se aplican a la seccion 3.6 con marcas `[v0.8.1]` donde corresponda.
3. Las 4 contradicciones cross-section se documentan en una subseccion nueva 3.6.9 "Notas de cohesion cross-section".
4. Los 3 cambios al schema requieren nuevas migraciones:
   - `agents.role` (para `role='coordinator'`).
   - `waiters.last_checked` (para recovery).
   - Indice `idx_events_logs`.
5. Tests de race condition se postergan a v0.9 (Sofia lidera).
6. Sandbox del DSL TS se posterga a v1.0 (riesgo aceptado documentado).
7. Baseline de memoria PM2 abierto como ticket `INFRA-102` (Dante, 48 h carga simulada).

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Actualizar spec.md a v0.8.1 con resoluciones + seccion 3.6.9 | 2026-05-17 |
| Mateo | Definir interface `WaiterResult` + `SubtaskPlan` en TaskContext | 2026-05-19 |
| Mateo | Implementar `runDetailed()` ademas de `run()` en `ctx.agent` | 2026-05-21 |
| Mateo | Migracion 000_init.sql con `PRAGMA journal_mode=WAL` | 2026-05-18 |
| Mateo | Campo `agents.role` y `waiters.last_checked` en migraciones | 2026-05-19 |
| Mateo | Filesystem lock en migration runner | 2026-05-19 |
| Mateo | Recovery de waiters huerfanos al startup del dispatcher | 2026-05-22 |
| Dante | `monitoring/check-restarts.sh` + cron cada 5 min | 2026-05-21 |
| Dante | Cambiar `ecosystem.config.js`: `min_uptime: 30000`, `listen_timeout: 10000` | 2026-05-18 |
| Dante | Carga simulada 48 h + baseline memoria → ticket INFRA-102 | 2026-05-30 |
| Sofia | Test suite tipos invalidos en `defineTask` (Zod) | 2026-05-22 |
| Sofia | Test race condition (postergado v0.9) — documentar plan | 2026-05-25 |
