# Arquitectura del Autonomous Orchestrator

> **Version**: 0.8.1  
> **Autor**: Roman (Tech Lead)  
> **Base**: [Spec v0.8.1](spec.md)  
> **Fecha**: 2026-05-16

---

## Resumen ejecutivo

El **Autonomous Orchestrator** es un motor de ejecucion de flujos de trabajo multi-agente basado en scripts, SQLite y waiters. Reemplaza la propuesta inicial de n8n por una arquitectura local-first sin dependencias externas de infraestructura.

**Principios fundacionales**:
- **Local-first**: cero infra remota en MVP. Todo corre en la maquina del operador.
- **Filesystem como API**: archivos JSON y SQLite son la fuente de verdad.
- **Procesos cortos**: cada script hace una cosa y muere. El daemon los bifurca.
- **Waiters como primitivos**: cualquier flujo que requiera entrada humana lo expresa con un waiter.

**Casos de uso principales**:
- Coordinar agentes autonomos (Claude Code, OpenAI, etc.) en pipelines multi-etapa.
- Pausar flujos ante aprobaciones humanas (arquitectura, deploys, hotfixes).
- Hibernar iniciativas hasta que condiciones externas se cumplan (precios, regulacion, dependencias).
- Coordinacion reactiva: el trabajo despierta cuando sus precondiciones son verdaderas.

---

## Diagrama de capas

```
┌────────────────────────────────────────────────────────────────────┐
│                     CLI Operator (orchestrator)                     │
│  start | stop | flow create | task show | waiter fulfill | logs    │
└────────────────────────────────────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Dispatcher (daemon)                          │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ Tick A (500ms)  : selector de tasks 'ready' -> spawn       │   │
│  │ Tick B (5000ms) : scheduler de waiters activos             │   │
│  │ Tick C (500ms)  : watcher de inbox/fifo (waiters pasivos)  │   │
│  │ Tick D (500ms)  : waiters next_check_at vencido            │   │
│  │ Tick E (250ms)  : consumer de events -> activacion tasks   │   │
│  │ Ciclo (60s)     : detector de deadlocks runtime            │   │
│  │ Chequeo         : .KILLSWITCH en cada tick                 │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Bifurca:                                                           │
│    - agent-runner <task-id>        (1 por task activa)             │
│    - waiter-checker <waiter-id>    (1 por waiter activo a pollear) │
└────────────────────────────────────────────────────────────────────┘
                    ▼                           ▼
        ┌─────────────────────┐      ┌──────────────────────┐
        │   Agent Runner      │      │  Waiter Checkers     │
        │  (proceso corto)    │      │  (scripts Bash)      │
        │                     │      │                      │
        │  1. Carga task      │      │  - task-dependency   │
        │  2. Invoca agente   │      │  - db-record-ready   │
        │     via AgentRunner │      │  - file-exists       │
        │  3. Persiste output │      │  - http-health       │
        │  4. Exit code       │      │  - goal-seeker (exp) │
        │     0=done 1=fail   │      │  - custom            │
        │     2=waiting       │      │                      │
        └─────────────────────┘      └──────────────────────┘
                    ▼                           ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Capa de Estado                               │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐   │
│  │  orchestrator.db     │  │  events.jsonl                    │   │
│  │  (SQLite WAL)        │  │  (append-only, hasheado)         │   │
│  │                      │  │                                  │   │
│  │  - flows             │  │  - flow.created/completed/failed │   │
│  │  - tasks             │  │  - task.started/finished/failed  │   │
│  │  - waiters           │  │  - waiter.fulfilled/timeout      │   │
│  │  - task_dependencies │  │  - gate.approved/rejected        │   │
│  │  - executions        │  │  - budget.exceeded               │   │
│  │  - artifacts         │  │  - killswitch.tripped            │   │
│  │  - gates             │  │                                  │   │
│  │  - agent_conversati… │  └──────────────────────────────────┘   │
│  │  - backlog_entries   │                                         │
│  │  - waiter_checks     │  ┌──────────────────────────────────┐   │
│  │  - events (internal) │  │  Filesystems                     │   │
│  │  - schema_migrations │  │                                  │   │
│  └──────────────────────┘  │  state/inbox/                    │   │
│                             │  state/outbox/                   │   │
│                             │  state/conversations/            │   │
│                             │  state/.KILLSWITCH               │   │
│                             └──────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Backends de Agentes                            │
│                                                                     │
│  - ClaudeCodeRunner (default): subprocess 'claude -p' headless     │
│  - OpenAIRunner (futuro): traduce a function calling               │
│  - LocalLLMRunner (futuro): llama.cpp / ollama / vLLM             │
│  - MockAgentRunner (tests): respuestas predefinidas               │
└────────────────────────────────────────────────────────────────────┘
```

---

## Modelo de ejecucion: los 5 ticks del dispatcher

El dispatcher es un daemon supervisado por PM2 que ejecuta 5 ticks independientes en paralelo:

| Tick | Frecuencia | Responsabilidad | Side-effects |
|------|------------|-----------------|--------------|
| **A** | 500 ms | Selector de tasks `ready`: aplica WSJF (Weighted Shortest Job First), limita por `MAX_WORKERS`, bifurca `agent-runner` | Actualiza `tasks.status='running'`, persiste `executions` |
| **B** | 5000 ms | Scheduler de waiters activos con `horizon='long'`: polling adaptativo de baja frecuencia | Bifurca waiter checkers, actualiza `waiter_checks` |
| **C** | 500 ms | Watcher de `state/inbox/` y `state/fifo/` para waiters pasivos | Valida input, mueve a `.processed/`, actualiza `waiters.status='fulfilled'` |
| **D** | 500 ms | Waiters activos cuyo `next_check_at <= now + 1000 ms` | Bifurca checkers, toma lease atomico |
| **E** | 250 ms | Consumer de tabla `events`: lee `consumed=0`, busca dependientes, marca tasks `ready` cuando todas las deps estan `done` | Actualiza `tasks.status='ready'`, marca `events.consumed=1`, emite a `events.jsonl` |

**Ciclos adicionales**:
- **Detector de deadlocks** (cada 60 s): topological sort sobre `task_dependencies` activas. Si hay ciclo, marca tasks involucradas como `failed` con razon `deadlock` y escala a Roman.
- **Kill-switch check** (en cada tick): si `state/.KILLSWITCH` existe, el dispatcher deja de bifurcar nuevos procesos y espera a que los workers en vuelo terminen.

---

## Tabla de procesos

| Proceso | Supervisado por | Frecuencia | Tipo | Timeout | Concurrencia |
|---------|-----------------|-----------|------|---------|--------------|
| `dispatcher` | PM2 | continuo (long-lived) | daemon Node | N/A | 1 instancia |
| `agent-runner` | dispatcher (child process) | por demanda | corto (exit 0/1/2) | 10 min | `MAX_WORKERS=3` |
| `waiter-checker` (Bash) | dispatcher (child process) | por demanda | corto (exit 0/1/2/3+) | 30 s | `MAX_ACTIVE_WAITERS=10` |
| `migration runner` | startup manual (`npm run migrate`) | una vez | corto | 2 min | 1 (filesystem lock) |
| `orchestrator` CLI | operador | por demanda | corto | depende del subcomando | N/A |

**Startup del dispatcher**:
1. Corre migraciones (`npm run migrate` automatico si `MIGRATE_ON_STARTUP=true`).
2. Valida PRAGMAs SQLite (WAL, foreign_keys, etc.).
3. Recovery de waiters huerfanos: `SELECT * FROM waiters WHERE mode='active' AND status='waiting' AND (last_checked IS NULL OR last_checked < now - 60s)`.
4. Emite `process.send('ready')` a PM2.
5. Arranca los 5 ticks + detector de deadlocks.

**Graceful shutdown**:
1. Detecta `.KILLSWITCH` o SIGTERM.
2. Para de bifurcar nuevos procesos.
3. Espera `kill_timeout=30s` a que workers terminen.
4. Cierra conexiones SQLite.
5. Exit code 0.

---

## Flujo de datos: ticket → flow → tasks → waiters → events

### Flujo normal (sin waiters)

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Operador dispara flow                                            │
│    orchestrator flow create hello-world --input '{"name":"angel"}'  │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. CLI crea flow + tasks iniciales en SQLite                        │
│    INSERT INTO flows (id, name, status, autonomy, ...)              │
│    INSERT INTO tasks (id, flow_id, stage, agent_id, status='ready') │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Tick A (selector) encuentra task 'ready'                         │
│    SELECT * FROM tasks WHERE status='ready' ORDER BY WSJF LIMIT 1   │
│    Bifurca: agent-runner <task-id>                                  │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. agent-runner ejecuta                                             │
│    - Carga task desde SQLite                                        │
│    - Invoca agente via ClaudeCodeRunner (claude -p)                 │
│    - Persiste output como artifact                                  │
│    - Actualiza tasks.status='done', tasks.output_json=resultado     │
│    - Exit code 0                                                    │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. Trigger SQLite tasks_done_trigger                                │
│    INSERT INTO events (kind='task.finished', payload_json=...)      │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. Tick E (consumer) lee event, busca dependientes                  │
│    Si hay, los marca 'ready'. Si no, el flow termina.               │
└─────────────────────────────────────────────────────────────────────┘
```

### Flujo con waiter pasivo

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Task ejecuta ctx.wait(approveArchitecture)                       │
│    - Crea row en waiters (mode='passive', kind='approve-arch', ...) │
│    - agent-runner exit code 2 (waiting)                             │
│    - tasks.status='waiting-waiter'                                  │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Operador responde                                                │
│    orchestrator waiter fulfill <id> --json '{"decision":"approved"}'│
│    O escribe state/inbox/<id>.input con JSON                        │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Tick C (watcher) detecta input                                   │
│    - Valida schema (Zod), authz, business rules                     │
│    - Ejecuta onValid() callback                                     │
│    - Actualiza waiters.status='fulfilled', value_json=input         │
│    - Marca task como 'queued'                                       │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Tick A re-toma la task, la pasa a 'ready' -> 'running'           │
│    agent-runner continua desde donde quedo, con ctx.lastWaiter      │
└─────────────────────────────────────────────────────────────────────┘
```

### Flujo con waiter activo (coordinacion reactiva)

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Task A declara dependsOnTag: ['backend-ready']                   │
│    - Se crea implicitamente un waiter activo (kind='task-dep')      │
│    - tasks.status='queued' (NO 'ready')                             │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Task B (con tag 'backend-ready') termina                         │
│    - Trigger tasks_done_trigger inserta en events                   │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Tick E lee evento, busca dependientes de Task B                  │
│    SELECT td.task_id FROM task_dependencies td                      │
│     WHERE td.depends_on_task_id = B.id                              │
│    Verifica si TODAS las deps de Task A estan 'done'                │
│    Si si, Task A -> 'ready'                                         │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Tick A selector toma Task A por WSJF y la ejecuta                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Cross-references al spec

| Concepto | Spec seccion |
|----------|--------------|
| Principios de diseno | 1 |
| Separacion observador/objeto observado | 1.7 |
| Estructura de directorios | 2 |
| Dispatcher | 3.1 |
| Agent Runner | 3.2 |
| AgentRunner interface (ADR-001) | 3.2.1, Anexo N |
| ClaudeCodeRunner | 3.2.2 |
| Mapeo L0-L5 → permission modes | 3.2.3 |
| Waiters (concepto) | 3.3 |
| Contrato Bash waiters activos | 3.3.3 |
| Evaluacion scheduler interno | 3.3.5 |
| TaskContext | 3.6.1 |
| flow-coordinator API | 3.6.2, 1.7.3 |
| DSL defineTask/defineSprint | 3.6.3 |
| Protocolo SQL waiter-antes-de-task | 3.6.4 |
| Migraciones SQL | 3.6.5 |
| PRAGMAs SQLite | 3.6.6 |
| PM2 ecosystem | 3.6.7 |
| Schema SQL completo | 4.1 |
| events.jsonl | 4.2 |
| Modelo de ejecucion (5 ticks) | 5 |
| Backlog vivo | 7 |
| Coordinacion reactiva | 7.10 |
| Work stealing (WSJF) | 7.10.5 |
| Deteccion de ciclos | 7.10.6 |
| Plan MVP | 8 |

---

## Limitaciones conocidas (por diseno, no bugs)

1. **SQLite mono-proceso**: WAL permite lectores concurrentes pero escritor unico. El dispatcher es el unico proceso que escribe. Scripts Bash solo leen. Esta limitacion es aceptable para el MVP (< 100 flows concurrentes).

2. **Sin rollback de migraciones**: las migraciones son forward-only. Si hay que retroceder, se escribe una nueva migracion que deshace los cambios. Esto simplifica enormemente el runner pero requiere disciplina.

3. **Waiters activos no subscriptions**: los waiters activos hacen polling, no subscriptions push. Esto tiene latencia inherente (minimo 1 segundo con `poll_interval_ms=1000`). Para casos real-time (<100ms), el patron waiter no aplica; se debe usar HTTP webhook directo.

4. **Token budget sin throttling dinamico**: el dispatcher valida budget ANTES de bifurcar un agent-runner, pero si el agente consume mas tokens de los estimados, el run se completa y el siguiente se rechaza. No hay throttling en medio del run. Esto es coherente con el principio de "procesos cortos" pero puede causar overspend temporal.

5. **Hibernacion de flows sin versionado automatico de contexto**: cuando un flow hiberna por meses y la version del orquestador cambia, la migracion de contexto es manual (politica minima 24 meses de soporte). Esto aplaza complejidad pero genera deuda.

6. **Dependencias circulares detectables solo en runtime en ciertos casos**: el detector pre-ejecucion (topological sort al crear sprint) NO cubre dependencias dinamicas generadas por el `flow-coordinator`. El detector runtime (cada 60 s) si las cubre, pero con latencia. Si se genera un ciclo, puede tardar hasta 1 minuto en detectarse.

7. **Backlog vivo sin alertas proactivas de obsolescencia**: la revision trimestral es manual (asistente interactivo). No hay alertas automaticas si un waiter lleva 12 meses sin cumplirse. Esto requiere disciplina del operador.

8. **Logs en events puede saturar con flows verbosos**: `ctx.log.info/warn/error` persiste cada linea en `events`. Un flow que loguea 1000 veces inserta 1000 filas. El indice `idx_events_logs` mitiga performance, pero el volumen crece sin particionamiento (diferido a v0.9).

9. **Concurrencia de agent runs limitada a semaforo fijo**: `MAX_CONCURRENT_AGENT_RUNS=10` es fijo, no adaptativo. Si hay burst, las runs esperan slot. No hay priority queue ni work stealing entre agent runs de distintos flows. Esto es suficiente para MVP pero limita throughput en produccion.

10. **Secrets en disco sin rotacion**: `ANTHROPIC_API_KEY` vive encriptada con sops+age en `state/secrets/`. La rotacion de keys es manual. No hay vault ni secret rotation automatica. Esto es aceptable para MVP operado por una persona, inaceptable para multi-tenant.

---

**Siguiente lectura recomendada**:
- [Dispatcher](components/dispatcher.md) — detalle de los 5 ticks
- [Agent Runner](components/agent-runner.md) — invocacion de agentes
- [Waiters](components/waiters.md) — contrato Bash y ciclo de vida
- [ADR-001](adr/0001-claude-headless-via-agent-runner-interface.md) — decision de usar `claude -p` headless
