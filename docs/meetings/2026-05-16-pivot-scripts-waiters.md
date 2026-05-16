# Reunion: Pivot a scripts puros + waiters
**Fecha:** 2026-05-16
**Equipo:** softwarefactory
**Convocada por:** Angel
**Participantes:** Roman (Tech Lead), Mateo (Backend), Dante (DevOps), Sofia (QA)
**Ausentes (no aplicaba):** Camila, Lucas, Valeria

## Contexto

Pivot tecnico respecto al BRD v1.0:
- Eliminar n8n de la arquitectura.
- Construir el orquestador 100% con scripts (Node + Bash glue).
- Introducir un concepto nuevo: **waiter** = script que valida entrada humana asincrona y reanuda un flujo bloqueado.

## Discusion

### Roman (Tech Lead)
De acuerdo con eliminar n8n. Era overhead para un flujo que necesita control granular de estado, reentrancia y validaciones custom. Scripts dan control total, zero vendor lock-in y debug directo.

Arquitectura propuesta:
- **Dispatcher** (Node): rutea intents, maneja prioridad y concurrencia (locks + max workers).
- **Agent Runner** (Node): ejecuta cada agente, persiste estado, emite eventos.
- **State Store**: propone MongoDB; tension con Mateo.
- **Waiters** (Node/Bash mix): escuchan, validan schema/business rules, escriben resultado y desbloquean al runner.
- **Operator CLI** (Node): listar pending waiters, aprobar/rechazar, ver flujos.

Lenguaje: Node para logica, Bash solo glue (async/await, JSON, Zod, drivers maduros).

Waiter: id, flow_id, prompt, schema (Zod), `listen_mode: 'cli' | 'fifo' | 'http_local'`, timeout, callbacks on_valid/on_timeout. Escucha por CLI (stdin/readline) o FIFO. Reanuda escribiendo al state; runner observa cambios. Expira con TTL.

Concurrencia: file locks o transacciones de DB, max workers en dispatcher, idempotency keys por step.

Riesgos: reinventar la rueda (retry/dead-letter/observability), debugging distribuido sin UI central, state consistency si el proceso muere entre "waiter valida" y "agente reanuda".

### Mateo (Backend)
Cambio de paradigma: salimos de cliente-servidor a orquestacion local. Propone **SQLite + JSONL hibrido**:
- SQLite para estado transaccional (flows, waiters, locks). ACID, sin daemon, queries rapidas.
- JSONL para logs append-only (eventos, auditoria). Inmutabilidad natural.
- **NO MongoDB**: cero overhead de red, cero daemon, suficiente para MVP.

Schema de waiter en SQLite con columnas: id, flow_id, step_id, prompt, schema_json, timeout_ms, created_at, status (waiting/fulfilled/timeout/invalid), value_json, attempts, last_attempt_at.

Patron "lock + inbox": row en SQLite con `status='waiting'` + archivo `inbox/<waiter-id>.input` donde el operador escribe JSON. Watcher por polling o inotify.

API local: **comando CLI directo sobre SQLite**, sin HTTP. `waiter fulfill <id> '{...}'` escribe directo a DB + valida con Zod. Cero latencia, debuggable, scriptable.

Idempotencia: si llega dos veces, segunda falla porque el `status` ya no es 'waiting'. Transaccion SQLite garantiza atomicidad.

### Dante (DevOps)
Recomienda **PM2** sobre systemd/cron/supervisord:
- Restart automatico en crash.
- Logs estructurados out-of-the-box (JSONL rotado).
- Cluster mode disponible si escala.
- `pm2 save` + `pm2 startup` para sobrevivir reboots.
- `pm2 monit` sin dependencias externas.

Tension con Roman/Mateo sobre ubicacion: Dante quiere los scripts en el repo principal del producto (`cobragest-nextjs/scripts/orchestrator/`) versionados con el codigo. Argumento: `~/.claude` es estado, no codigo.

**Resolucion propuesta:** los scripts del **orquestador** (motor generico de SoftwareFactory) viven en `~/.claude/teams/softwarefactory/projects/autonomous-orchestrator/bin/`. Los flujos especificos de un producto (ej. cobragest) viven en el repo de ese producto.

Invocacion de waiter: el daemon principal lo bifurca con `child_process.spawn`. Lee de stdin o archivo, valida, escribe resultado, muere. Sin inotifywait, sin complejidad extra.

Logs: PM2 con `--log-type json --merge-logs --max-restarts 5`, rotacion automatica, parseables.

Kill-switch: archivo centinela `.KILLSWITCH`. Si existe, el daemon hace `process.exit(0)` en cada ciclo. `pm2 stop all` como fallback.

Costo: $0 local confirmado.

### Sofia (QA)
Pasar de motor formal a scripts transfiere garantias del motor a nuestro codigo. Hay que compensar con tests.

Contrato testeable de un waiter: schema de entrada (Zod), casos valid/invalid (extremos, faltantes, malformados), timeout (que devuelve si expira), dedup (mismo input no se procesa dos veces).

Validaciones obligatorias en TODO waiter:
1. Schema estructural (tipos, formato).
2. Reglas de negocio (rangos, dependencias entre campos).
3. Autorizacion contextual (quien puede aprobar segun estado).
4. Idempotencia (token/ID unico por request).
5. Expiracion (timestamp de validez).

Lo que perdemos vs n8n/Temporal: retry automatico, observabilidad, persistencia, dead-letter queues. Lo compensamos con tests de resiliencia (crash recovery), tests de reintentos, logs estructurados obligatorios, timeouts explicitos.

Test harness: mock del SDK Claude con respuestas predefinidas. Fixtures por flujo. Scripts de setup que inyectan estado inicial. Validacion de logs. Tests E2E con datos sinteticos.

## Tensiones y decisiones

### Tension 1: persistencia (Roman MongoDB vs Mateo SQLite)
- **Resolucion**: SQLite + JSONL en MVP. Si superamos 100 flujos concurrentes o necesitamos change streams, migramos a Mongo. Postergamos la decision con un plan claro.

### Tension 2: ubicacion del codigo (Dante repo producto vs `~/.claude`)
- **Resolucion**: el **motor** del orquestador es generico y vive en `~/.claude/teams/softwarefactory/projects/autonomous-orchestrator/`. Los **flujos** que orquesta (codigo de productos) viven en cada repo. El motor SE PUEDE versionar en git desde su propia carpeta.

### Tension 3: modos de escucha del waiter (CLI vs FIFO vs HTTP local vs polling de inbox)
- **Resolucion**: el waiter soporta 3 modos de entrada, configurables por flujo:
  1. **CLI** (default): `orchestrator waiter fulfill <id> '{...}'`
  2. **Inbox file**: el operador escribe en `inbox/<id>.input` (util para integraciones futuras).
  3. **FIFO local**: para integraciones programaticas.

## Decisiones

1. Eliminar n8n del stack. Reemplazo: scripts Node + Bash glue.
2. Concepto formal de **waiter** adoptado. Definicion en el spec.
3. Stack MVP: Node 20+, SQLite (via better-sqlite3), JSONL, PM2.
4. Schema de validacion: Zod.
5. Motor vive en `~/.claude/teams/softwarefactory/projects/autonomous-orchestrator/`.
6. Operador interactua via CLI (`orchestrator ...`). Modos alternativos (inbox/fifo) soportados pero no son default.
7. Kill-switch via archivo `.KILLSWITCH`.
8. Sofia entrega test harness con mocks del SDK antes del primer flujo real.
9. Spec.md inicial es entregable inmediato de esta reunion.

## Action Items

| Responsable | Tarea | Fecha |
|---|---|---|
| Roman | Owner del spec.md inicial, lo firma antes de ejecucion | 2026-05-17 |
| Mateo | Schema SQL definitivo + dao de waiters | 2026-05-19 |
| Dante | Skeleton del daemon + ecosystem.config.js + PM2 | 2026-05-20 |
| Sofia | Test harness con mocks del SDK Claude | 2026-05-22 |
| Roman + Mateo | Definir contrato `Waiter` (interface TypeScript) | 2026-05-18 |
