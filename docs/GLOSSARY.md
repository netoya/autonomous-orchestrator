# Glosario

Glosario alfabetico de terminos del proyecto SoftwareFactory Autonomous Orchestrator. Cada termino incluye definicion breve y referencia a la seccion del spec donde aplica.

---

## A

### Agent

Un agente IA especializado (ej. Camila, Roman, Mateo, Valeria, Sofia, Dante, Lucas) que ejecuta tareas especificas dentro de un flujo. El orquestador invoca agentes a traves de la interfaz `AgentRunner` (ver spec 3.2.1).

**Referencia**: [spec 3.2](../spec.md#32-agent-runner)

### AgentRunner

Interfaz TypeScript que abstrae la invocacion de un agente IA. La implementacion default es `ClaudeCodeRunner` (sobre `claude -p` headless), pero permite swapear el backend (OpenAI, modelo local, mock para tests) sin tocar el motor.

**Metodos principales**: `run(params)` → `Promise<AgentRunResult>`.

**Referencia**: [spec 3.2.1](../spec.md#321-interfaz-agentrunner-adr-001)

### Artifact

Artefacto producido por una `Execution` (ej. PRD, mockup, diff, reporte de tests, logs). Se persiste en filesystem (`state/outbox/`) con hash SHA-256 y metadata en la tabla `artifacts`.

**Referencia**: [spec 4.1 tabla artifacts](../spec.md#41-esquema-sql-resumen)

---

## B

### Backlog vivo (Living backlog)

Patron habilitado por waiters activos de horizonte `long`. Cuando un waiter puede tardar dias, semanas o meses en cumplirse, el flow asociado entra en estado `hibernated`: el contexto se serializa, el flow se retira de memoria activa, y el waiter sigue haciendo polls adaptativos hasta que la condicion se cumple. Eso permite pipelines que esperan largos periodos sin consumir recursos.

**Ejemplo**: esperar a que un usuario compre licencia enterprise antes de habilitar feature X.

**Referencia**: [spec seccion 7](../spec.md#7-backlog-vivo) | [spec 3.3 dimension horizon](../spec.md#33-waiter)

---

## C

### ClaudeCodeRunner

Implementacion default de `AgentRunner` que wrappea `claude -p` (headless). Parsea flags, inyecta `ANTHROPIC_API_KEY` al child process, lee stdout como JSON, extrae `result`, `session_id`, `total_cost_usd`, `num_turns`, `usage`.

**Flags prohibidos**: `--dangerously-skip-permissions` (rechazado con error).

**Referencia**: [spec 3.2.2](../spec.md#322-implementacion-default-claudecoderunner)

### Coordinator (flow-coordinator)

Agente especial con `agentId='flow-coordinator'` que tiene permiso explicito para crear sub-tasks dinamicamente. Es la **unica excepcion** al principio 1.7 (observador/observado). Recibe un plan de alto nivel, lo descompone en tasks, declara dependencias, y delega la ejecucion al dispatcher. Cada emision de sub-task queda registrada en `events` con `kind='task.spawned-by-coordinator'` para trazabilidad.

**API**: recibe artifact JSON con plan, valida schema, crea tasks en SQLite, retorna lista de IDs.

**Referencia**: [spec 3.6.2](../spec.md#362-api-del-flow-coordinator) | [spec 1.7.3](../spec.md#173-excepcion-controlada-flow-coordinator)

---

## D

### Dispatcher

Daemon principal del orquestador (supervisado por PM2). Responsable de leer SQLite cada N ms, limitar workers concurrentes, bifurcar agent-runners, capturar exit codes, persistir estado, encolar reintentos, chequear kill-switch, verificar budget de tokens.

**Ticks**:
- **Tick A** (500 ms): levantar tasks en `ready` con WSJF.
- **Tick B** (5000 ms): scheduler de waiters activos.
- **Tick C** (500 ms): watcher de inbox/ y fifo/ (waiters pasivos).
- **Tick D** (60 s): calcular metricas de latencia.
- **Tick E** (5 min): emitir eventos a JSONL y limpiar tabla `events`.

**Referencia**: [spec 3.1](../spec.md#31-dispatcher-daemon) | [spec seccion 5 Modelo de ejecucion](../spec.md#5-modelo-de-ejecucion)

---

## E

### Event

Registro append-only en `events.jsonl`. Cada linea es un JSON con `ts`, `flow_id`, `kind`, `payload`, `hash`. Eventos minimos: `flow.created`, `task.started`, `task.finished`, `waiter.fulfilled`, `gate.approved`, `budget.exceeded`, `killswitch.tripped`.

**Referencia**: [spec 4.2](../spec.md#42-eventsjsonl)

### Execution

Registro de una invocacion concreta de un agente para ejecutar una task. Persiste en tabla `executions` con `id`, `task_id`, `agent_id`, `started_at`, `finished_at`, `status`, `tokens_input`, `tokens_output`. Una task puede tener multiples executions (retries).

**Referencia**: [spec 4.1 tabla executions](../spec.md#41-esquema-sql-resumen)

---

## F

### Flow

Pipeline completa que modela un proceso de negocio (ej. "desarrollo de feature end-to-end"). Compuesto por multiples `Sprint`s y `Task`s. Estado persistido en tabla `flows` con `status` (`queued`, `running`, `waiting`, `hibernated`, `completed`, `failed`, `cancelled`).

**Referencia**: [spec 4.1 tabla flows](../spec.md#41-esquema-sql-resumen)

---

## G

### Gate

Punto de aprobacion humana obligatorio (ej. aprobar arquitectura, deploy a produccion, hotfix critico). Persiste en tabla `gates` con `decision` (`pending`, `approved`, `rejected`). El flow se bloquea hasta que el gate se resuelve.

**Referencia**: [spec 4.1 tabla gates](../spec.md#41-esquema-sql-resumen) | [BRD seccion 5.1 FR-08](../brd/BRD-es.md#51-requerimientos-funcionales)

### Goal-seeker

Patron EXPERIMENTAL (Anexo M) para waiters que no solo validan condiciones, sino que intentan **remediarlas** si no se cumplen. Estructura: validador → remedios → validador' → waiter recursivo. Sin cambios al schema SQL; todo modelado como secuencia de waiters activos con scripts que invocan sub-agentes.

**Garantias**: 8 documentadas en Anexo M. Requiere 2-3 casos reales antes de promoverse a `kind='goal-seeking'` formal.

**Referencia**: [spec Anexo M](../spec.md#23-anexo-m-goal-seekersh-experimental) | [spec 3.3.3 catalogo](../spec.md#333-contrato-bash-unificado-para-waiters-activos)

---

## H

### Hibernated (estado)

Estado de un `Flow` cuyo waiter activo tiene horizonte `long` y aun no se cumplio. El contexto se serializa en artifact, el flow se retira de memoria activa, y el waiter sigue haciendo polls adaptativos. Permite backlog vivo sin consumir recursos.

**Transicion**: `waiting` → `hibernated` (cuando waiter pasa a long-term polling) → `running` (cuando waiter se cumple).

**Referencia**: [spec seccion 7](../spec.md#7-backlog-vivo) | [spec tabla waiters](../spec.md#331-estado-del-waiter-sqlite)

### Horizon

Dimension ortogonal de un waiter que indica cuanto puede durar en estado `waiting`:

- **`short`**: minutos a horas (hasta 48 h). Flow en `waiting`, polling cada segundos/minutos.
- **`long`**: dias, semanas, meses, anos. Flow en `hibernated`, polling adaptativo (horas a semanas).

**Referencia**: [spec 3.3 dimension horizon](../spec.md#33-waiter)

---

## I

### Idempotency key

Clave unica por task (hash de `flow_id + task_id + iteration`) que garantiza que la misma task no se ejecuta dos veces ante retries o reintentos. Indice unico en tabla `tasks`.

**Referencia**: [spec 4.1 tabla tasks](../spec.md#41-esquema-sql-resumen)

---

## K

### Kill-switch

Archivo `.KILLSWITCH` en `state/`. Si existe, el dispatcher detiene todas las pipelines activas en menos de 60 s (drain de waiters + cierre limpio de DB + flush de logs). Emite evento `killswitch.tripped` en JSONL.

**Procedimiento**: `touch ./state/.KILLSWITCH` → esperar drain → `pm2 stop` → deploy → `rm .KILLSWITCH` → `pm2 start`.

**Referencia**: [spec 3.1 Dispatcher](../spec.md#31-dispatcher-daemon) | [spec 3.6.7 PM2 runbook](../spec.md#367-pm2-ecosystemconfigjs)

---

## L

### Latent task

Task que aun no puede ejecutarse porque sus dependencias no estan cumplidas o su waiter no esta fulfilled. Vive en el backlog (estado `queued` o `waiting`) hasta que las condiciones se cumplen. Cuando todas sus dependencias estan en `done` y sus waiters en `fulfilled`, transiciona a `ready` y el dispatcher la encola.

**Referencia**: [spec 3.3.3 waiters activos](../spec.md#333-contrato-bash-unificado-para-waiters-activos) | [spec seccion 7 backlog vivo](../spec.md#7-backlog-vivo)

### Lease pattern

Mecanismo para evitar concurrencia en waiters activos. Antes de checkear un waiter, el scheduler toma un **lease** atomico (UPDATE ... WHERE lease_until IS NULL RETURNING *). Si el RETURNING no devuelve fila, otro proceso ya lo tomo. El lease tiene TTL (`lease_ttl_ms`, default 30 s) y se libera tras el check.

**Referencia**: [spec 3.3.5 evaluacion de waiters activos](../spec.md#335-evaluacion-de-waiters-activos-scheduler-interno)

---

## M

### Milestone

Task marcada con `isMilestone: true` que actua como checkpoint dentro de un sprint. Permite invocaciones `orchestrator run sprint --until-milestone <name>` (ejecuta hasta ese punto y pausa). Util para desarrollo iterativo y debugging.

**Referencia**: [spec 4.1 tabla tasks campo is_milestone](../spec.md#41-esquema-sql-resumen)

---

## O

### Observer / Observed (principio 1.7)

**Principio arquitectonico fundamental**: una task (objeto observado) NO controla el futuro del flujo. Solo emite estado final (`done`, `failed`, `waiting`). Los waiters (observadores) observan esas transiciones y deciden si corresponde reactivar, desbloquear o encadenar nuevo trabajo.

**Beneficios**: elimina acoplamiento temporal, evita race conditions, facilita hibernacion y reanudacion asincronica.

**Campos prohibidos** en API de tasks: `onSuccess`, `onFailure`, `nextTask`, `callbackTo`, `then`.

**Excepcion**: `flow-coordinator` (ver Coordinator).

**Analogia**: "Las tareas no tienen telefonos. Terminan y se van. Otras tareas estan atentas y arrancan cuando ven que ya pueden hacerlo." (Camila, para comunicacion al equipo).

**Referencia**: [spec 1.7](../spec.md#17-separacion-entre-observador-y-objeto-observado)

---

## P

### Permission mode

Flag de autonomia del agente (mapeo de niveles L0-L5 del BRD):

- **`default`**: L1-L2. Sin ediciones automaticas.
- **`acceptEdits`**: L3-L4. Agente puede editar archivos con aprobacion humana diferida. Requiere sandbox Docker.
- **`plan`**: L1-L2. Solo read/grep/glob, sin writes.
- **`bypassPermissions`**: L5. Autonomia maxima en sandbox. Sandbox Docker obligatorio.

`--dangerously-skip-permissions` esta **prohibido**.

**Referencia**: [spec 3.2.3 mapeo niveles autonomia](../spec.md#323-mapeo-niveles-de-autonomia-brd--permission-modes)

---

## S

### Sprint

Conjunto de tasks relacionadas que se ejecutan como unidad. Definido con `defineSprint({ name, tasks })`. Cada sprint tiene su propio grafo de dependencias (DAG). Puede ser invocado en modos `single-task`, `until-milestone`, `sprint-completo`.

**Referencia**: [spec 3.6.3 DSL defineTask/defineSprint](../spec.md#363-dsl-definetaskdefinesprint)

---

## T

### Task

Unidad minima de trabajo. Persiste en tabla `tasks` con `status` (`queued`, `ready`, `running`, `waiting-waiter`, `done`, `failed`, `cancelled`). Cada task se asigna a un agente, recibe input JSON, produce output JSON, y puede declarar dependencias (`dependsOn`, `dependsOnTag`) y waiters (`waitFor`).

**Referencia**: [spec 4.1 tabla tasks](../spec.md#41-esquema-sql-resumen)

### Task dependency

Dependencia explicita entre dos tasks. Modelada en tabla `task_dependencies` con `kind` (`finish-to-start` o `tag-resolved`). Una task solo transiciona a `ready` cuando todas sus dependencias estan en `done`.

**Referencia**: [spec 4.1 tabla task_dependencies](../spec.md#41-esquema-sql-resumen) | [spec v0.4 coordinacion reactiva](../spec.md#changelog)

### TaskContext

Interfaz del objeto `ctx` que reciben los flows al ejecutarse. Provee metodos para:

- **Control de flujo**: `wait(spec)`, `complete(output)`, `fail(reason)`.
- **Logging**: `log.info()`, `log.warn()`, `log.error()`.
- **Artifacts**: `artifacts.write(type, data)`.
- **Activacion de dependientes**: `activatePendingDependents(taskIds)`.
- **Spawn** (solo flow-coordinator): `spawnSubtasks(plan)`.
- **Invocacion de agentes**: `agent.run(agentId, prompt)`, `agent.runDetailed(agentId, prompt, opts)`.

**Referencia**: [spec 3.6.1](../spec.md#361-taskcontext--interfaz-del-objeto-ctx-que-reciben-los-flows)

### Tick

Ciclo periodico del dispatcher:

- **Tick A** (500 ms): levantar tasks en `ready` con WSJF.
- **Tick B** (5000 ms): scheduler de waiters activos.
- **Tick C** (500 ms): watcher de inbox/ y fifo/ (waiters pasivos).
- **Tick D** (60 s): calcular metricas de latencia.
- **Tick E** (5 min): emitir eventos a JSONL y limpiar tabla `events`.

**Referencia**: [spec seccion 5 Modelo de ejecucion](../spec.md#5-modelo-de-ejecucion)

---

## W

### Waiter

Primitivo de bloqueo/reanudacion del flujo. Pausa un flow hasta que una condicion se cumple. Dos tipos:

- **Pasivo** (`mode='passive'`): espera entrada humana via CLI, inbox/ o FIFO.
- **Activo** (`mode='active'`): el scheduler chequea una condicion periodicamente (query SQL, archivo en disco, endpoint HTTP, etc.).

Dos dimensiones ortogonales:

- **`mode`**: `passive` vs `active`.
- **`horizon`**: `short` (minutos-horas) vs `long` (dias-meses-anos).

**Contrato Bash** (activos): env vars (`WAITER_ID`, `WAITER_PARAMS_JSON`, `DB_PATH`, `STATE_DIR`) + exit codes (0=cumplido, 1=no cumplido, 2=error transitorio, >=3=error fatal) + stdout JSON.

**Ciclo de vida**: `waiting` → `fulfilled` (o `rejected`, `timeout`, `invalid`).

**Referencia**: [spec 3.3](../spec.md#33-waiter)

### Waiter activo

Waiter con `mode='active'`. El scheduler lo checkea periodicamente ejecutando un script Bash. El script retorna exit code 0 si la condicion se cumple, 1 si no, 2 si error transitorio, >=3 si error fatal.

**Catalogo base**: `task-dependency.sh`, `flow-dependency.sh`, `db-record-ready.sh`, `file-exists.sh`, `http-health.sh`, `goal-seeker.sh` (experimental).

**Referencia**: [spec 3.3.3 contrato Bash](../spec.md#333-contrato-bash-unificado-para-waiters-activos) | [spec 3.3.2 interface TS](../spec.md#332-interface-typescript)

### Waiter pasivo

Waiter con `mode='passive'`. Espera entrada humana via:

1. **CLI**: `orchestrator waiter fulfill <id> --json '{...}'`.
2. **Inbox file**: operador escribe `state/inbox/<id>.input` con JSON valido.
3. **FIFO**: `echo '{...}' > state/fifo/<id>`.

**Tipos**: `approve-architecture`, `approve-prod-deploy`, `approve-hotfix`, `free-text`, `choose-option`, `numeric`, `json-blob`.

**Referencia**: [spec 3.3.4 modos de entrega](../spec.md#334-modos-de-entrega-de-la-entrada-solo-modepassive) | [spec 3.3.2 interface TS](../spec.md#332-interface-typescript)

### Work stealing

Patron de scheduling donde el dispatcher selecciona la proxima task a ejecutar usando WSJF (Weighted Shortest Job First): `business_value / estimated_minutes`. Evita que tasks largas bloqueen la cola ante multiples cortas de alto valor.

**Query**: `SELECT * FROM tasks WHERE status='ready' ORDER BY (business_value / NULLIF(estimated_minutes, 0)) DESC LIMIT :MAX_WORKERS`.

**Referencia**: [spec v0.4 coordinacion reactiva](../spec.md#changelog) | [spec 4.1 tabla tasks](../spec.md#41-esquema-sql-resumen)

### WSJF (Weighted Shortest Job First)

Algoritmo de priorizacion que balancea valor de negocio (`business_value`, escala 1-10) vs esfuerzo estimado (`estimated_minutes`). Formula: `WSJF = business_value / estimated_minutes`. Tasks con WSJF mayor se ejecutan primero.

**Referencia**: [spec v0.4 coordinacion reactiva](../spec.md#changelog)

---

## Recursos

- [Spec completa (v0.8.1)](../spec.md)
- [BRD (espanol)](../brd/BRD-es.md)
- [Guia: escribir un flow](guides/writing-a-flow.md)
- [Guia: escribir un waiter](guides/writing-a-waiter.md)
- [Guia: operar el orquestador](guides/operating-the-orchestrator.md)
- [Referencia CLI](reference/cli.md)
