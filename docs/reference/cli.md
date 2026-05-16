# Referencia CLI — orchestrator

Referencia exhaustiva de todos los subcomandos del CLI `orchestrator`. Cada seccion incluye sinopsis, flags, ejemplo, y output esperado.

---

## Resumen de subcomandos

| Categoria | Subcomando | Descripcion |
|---|---|---|
| **Sistema** | `start` | Arranca el dispatcher via PM2 |
| | `stop` | Crea `.KILLSWITCH` y para PM2 |
| | `status` | Estado global + flows activos |
| **Flows** | `flow create` | Dispara una pipeline nueva |
| | `flow list` | Lista flows (filtrable por status) |
| | `flow show` | Detalle de un flow especifico |
| **Sprints** | `run sprint --full` | Ejecuta sprint completo |
| | `run sprint --until-milestone` | Ejecuta hasta milestone |
| | `sprint plan --validate` | Valida grafo sin ejecutar |
| **Tasks** | `run task` | Ejecuta una sola task |
| | `task list` | Lista tasks (filtrable por status) |
| | `task show` | Detalle de una task |
| | `task deps` | Subgrafo de dependencias |
| **Waiters** | `waiter list` | Lista waiters |
| | `waiter show` | Detalle de un waiter |
| | `waiter fulfill` | Aprueba un waiter pasivo |
| | `waiter reject` | Rechaza un waiter pasivo |
| **Backlog** | `backlog list` | Lista entradas del backlog vivo |
| | `backlog show` | Detalle de una entrada |
| | `backlog review` | Asistente interactivo trimestral |
| | `backlog extend` | Extiende vida de entrada |
| | `backlog cancel` | Cancela entrada |
| | `backlog wake` | Fuerza despertar (skip condicion) |
| **Observabilidad** | `logs` | Tail de eventos JSONL filtrados |
| | `budget show` | Resumen de costos y budget |
| | `budget set` | Ajusta limite diario de tokens |
| | `deadlock check` | Detector de ciclos en dependencias |

---

## Sistema

### `orchestrator start`

Arranca el dispatcher via PM2.

**Sinopsis**:

```bash
orchestrator start [--config <path>]
```

**Flags**:

- `--config <path>`: Ruta a `ecosystem.config.js` custom (default: `./ecosystem.config.js`).

**Ejemplo**:

```bash
npx orchestrator start
```

**Output esperado**:

```
[PM2] Starting dispatcher...
[PM2] Done.

orchestrator status
┌─────┬────────────────────────────┬─────────┬─────────┬──────────┐
│ id  │ name                       │ status  │ restart │ uptime   │
├─────┼────────────────────────────┼─────────┼─────────┼──────────┤
│ 0   │ softwarefactory-orch...    │ online  │ 0       │ 2s       │
└─────┴────────────────────────────┴─────────┴─────────┴──────────┘

Dispatcher online. Ready to accept flows.
```

**Que hace**:

1. Ejecuta `pm2 start ecosystem.config.js`.
2. El dispatcher arranca, aplica migraciones pendientes, recupera waiters huerfanos.
3. Empieza los ticks A/B/C/D/E.

**Notas**:

- Si el dispatcher ya esta corriendo, sale con warning `Already running`.
- Si existen migraciones pendientes, las aplica antes de arrancar.

---

### `orchestrator stop`

Crea `.KILLSWITCH` y para PM2.

**Sinopsis**:

```bash
orchestrator stop [--force]
```

**Flags**:

- `--force`: Para PM2 sin esperar drain (solo usar ante emergencia).

**Ejemplo**:

```bash
npx orchestrator stop
```

**Output esperado**:

```
Kill-switch activated.
Waiting for dispatcher to drain...
[PM2] Stopping softwarefactory-orchestrator...
[PM2] Done.

Dispatcher stopped cleanly.
```

**Que hace**:

1. Crea `state/.KILLSWITCH`.
2. Espera a que el dispatcher detecte el kill-switch (< 500 ms).
3. El dispatcher drena waiters activos (max 30 s), cierra DB, flush de logs.
4. Emite evento `killswitch.tripped` en JSONL.
5. Ejecuta `pm2 stop softwarefactory-orchestrator`.

**Tiempo garantizado**: < 60 s.

**Notas**:

- Con `--force`, saltea el drain y mata el proceso directo. Puede dejar waiters huerfanos.

---

### `orchestrator status`

Estado global del orquestador + flows activos.

**Sinopsis**:

```bash
orchestrator status [--json]
```

**Flags**:

- `--json`: Output en formato JSON (para scripts).

**Ejemplo**:

```bash
npx orchestrator status
```

**Output esperado**:

```
Orchestrator Status
===================

Dispatcher: online (uptime: 2h 34m)
DB: state/orchestrator.db (size: 12.3 MB, WAL: enabled)
Flows active: 3
Tasks queued: 7
Tasks running: 2
Waiters pending: 4
Budget today: 12,345 / 50,000 tokens (24.7%)

Active flows:
  flow_abc123  hello-world          running    4/7 tasks done    23 min
  flow_def456  feature-onboarding   waiting    2/5 tasks done    1h 12m
  flow_ghi789  backlog-check        hibernated 0/3 tasks done    3 days

Recent events (last 10):
  2026-05-16 14:32:15  task.finished     task_xyz (escribir-tests)
  2026-05-16 14:30:10  waiter.fulfilled  waiter_abc (approve-architecture)
  2026-05-16 14:15:05  task.started      task_def (implementar-backend)
  ...
```

**Formato JSON** (`--json`):

```json
{
  "dispatcher": { "status": "online", "uptime_ms": 9240000 },
  "db": { "path": "state/orchestrator.db", "size_bytes": 12345678, "wal_enabled": true },
  "flows": { "active": 3, "queued": 1, "running": 2, "waiting": 1, "hibernated": 0 },
  "tasks": { "queued": 7, "ready": 0, "running": 2, "waiting": 1, "done": 14, "failed": 0 },
  "waiters": { "pending": 4, "fulfilled": 10, "rejected": 1, "timeout": 0 },
  "budget": { "daily_limit": 50000, "used_today": 12345, "remaining": 37655 }
}
```

---

## Flows

### `orchestrator flow create`

Dispara una pipeline nueva.

**Sinopsis**:

```bash
orchestrator flow create <flow-name> [--input <json>] [--autonomy <level>] [--budget <tokens>]
```

**Flags**:

- `--input <json>`: Input JSON para el flow (opcional, default `{}`).
- `--autonomy <level>`: Nivel de autonomia (L0-L5, default L3).
- `--budget <tokens>`: Budget de tokens para este flow (opcional, usa budget global si no se especifica).

**Ejemplo**:

```bash
npx orchestrator flow create hello-world --input '{"message":"hola mundo"}' --autonomy L3
```

**Output esperado**:

```
Flow created: flow_abc123
Name: hello-world
Status: queued
Tasks: 7 (5 queued, 2 ready)
Autonomy: L3

Next steps:
  - Monitor: npx orchestrator flow show flow_abc123
  - Logs: npx orchestrator logs flow_abc123
```

**Que hace**:

1. Carga el sprint desde `src/flows/<flow-name>.flow.ts`.
2. Valida el grafo de dependencias (DAG).
3. Crea row en tabla `flows` con `status='queued'`.
4. Crea rows en tabla `tasks` (una por cada `defineTask` del sprint).
5. Crea rows en tabla `task_dependencies` segun `dependsOn` / `dependsOnTag`.
6. Transiciona tasks sin dependencias a `status='ready'`.
7. Emite evento `flow.created` en JSONL.

**Notas**:

- Si el flow-name no existe, sale con error `Flow not found: <flow-name>`.
- Si el grafo tiene ciclos, sale con error `Cycle detected: A → B → C → A`.

---

### `orchestrator flow list`

Lista flows (filtrable por status).

**Sinopsis**:

```bash
orchestrator flow list [--status <status>] [--limit <n>] [--json]
```

**Flags**:

- `--status <status>`: Filtra por status (`queued`, `running`, `waiting`, `hibernated`, `completed`, `failed`, `cancelled`).
- `--limit <n>`: Limita resultados (default 50).
- `--json`: Output en JSON.

**Ejemplo**:

```bash
npx orchestrator flow list --status running
```

**Output esperado**:

```
ID           Name               Status     Progress   Elapsed   Created
flow_abc123  hello-world        running    4/7        23 min    2026-05-16 12:00
flow_def456  feature-onboard    running    2/5        1h 12m    2026-05-16 11:30
```

---

### `orchestrator flow show`

Detalle de un flow especifico.

**Sinopsis**:

```bash
orchestrator flow show <flow-id> [--json]
```

**Ejemplo**:

```bash
npx orchestrator flow show flow_abc123
```

**Output esperado**:

```
Flow: hello-world (flow_abc123)
Status: running
Progress: 4/7 tasks done (57%)
Elapsed: 23 min
Created: 2026-05-16 12:00 UTC
Autonomy: L3
Budget: 5,678 / 10,000 tokens (56.8%)

Tasks:
  [done]            escribir-req          (10 min, 1,234 tokens)
  [done]            disenar-ux            (15 min, 2,345 tokens)
  [done]            revisar-arquitectura  (5 min, 1,123 tokens)
  [running]         implementar-backend   (8 min so far, 976 tokens)
  [queued]          escribir-tests        (waiting for: implementar-backend)
  [queued]          validar-cobertura     (waiting for: escribir-tests)
  [queued]          deploy-staging        (waiting for: validar-cobertura)

Waiters pending: 0

Artifacts produced: 3
  artifact_xyz (architecture-proposal.md, 3.2 KB)
  artifact_abc (mockup.json, 1.5 KB)
  artifact_def (endpoint-code.ts, 8.7 KB)
```

---

## Sprints

### `orchestrator run sprint --full`

Ejecuta sprint completo.

**Sinopsis**:

```bash
orchestrator run sprint --full <sprint-name-or-id>
```

**Ejemplo**:

```bash
npx orchestrator run sprint --full hello-world
```

**Output esperado**:

```
Sprint: hello-world (spr_abc123)
Tasks: 7 total (5 queued, 2 ready)

Executing...
  [done] escribir-req (10 min)
  [done] disenar-ux (15 min)
  [waiting-waiter] revisar-arquitectura (waiter: approve-architecture)

Sprint paused. Waiting for waiter approval.

Resume with: npx orchestrator waiter fulfill <waiter-id> --json '{...}'
```

**Que hace**:

1. Carga el sprint.
2. Ejecuta tasks en orden topologico (respetando dependencias).
3. Si encuentra waiter pasivo, pausa y emite instruccion.
4. Si todos los waiters se cumplen, continua hasta terminar el sprint.

---

### `orchestrator run sprint --until-milestone`

Ejecuta hasta milestone.

**Sinopsis**:

```bash
orchestrator run sprint <sprint-id> --until-milestone <milestone-name>
```

**Ejemplo**:

```bash
npx orchestrator run sprint spr_abc123 --until-milestone validar-cobertura
```

**Output esperado**:

```
Sprint: hello-world (spr_abc123)
Target milestone: validar-cobertura

Executing...
  [done] escribir-req
  [done] disenar-ux
  [done] revisar-arquitectura
  [done] implementar-backend
  [done] escribir-tests
  [done] validar-cobertura (milestone reached)

Paused at milestone. Tasks after this milestone remain queued.

Continue full sprint with: npx orchestrator run sprint spr_abc123 --full
```

---

### `orchestrator sprint plan --validate`

Valida grafo sin ejecutar.

**Sinopsis**:

```bash
orchestrator sprint plan --validate <flow-file>
```

**Ejemplo**:

```bash
npx orchestrator sprint plan --validate src/flows/hello-world.flow.ts
```

**Output esperado (valido)**:

```
Validating: hello-world
Tasks: 7
Dependencies: 6
Topological order: escribir-req → disenar-ux → revisar-arquitectura → implementar-backend → escribir-tests → validar-cobertura → deploy-staging

✓ No cycles detected
✓ All dependencies resolve
✓ All agentIds exist
✓ Schema valid

Sprint is valid.
```

**Output esperado (invalido)**:

```
Validating: broken-flow
Tasks: 5

✗ Cycle detected: task-A → task-B → task-C → task-A
✗ Task 'task-D' depends on 'task-X' which does not exist
✗ Schema validation failed: task-E.prompt is required

Sprint is invalid. Fix errors before running.
```

---

## Tasks

### `orchestrator run task`

Ejecuta una sola task (sin waiters intra-sprint).

**Sinopsis**:

```bash
orchestrator run task <task-id>
```

**Ejemplo**:

```bash
npx orchestrator run task task_abc123
```

**Output esperado**:

```
Task: implementar-backend (task_abc123)
Agent: softwarefactory_mateo
Status: running

[logs streaming...]

Task completed in 8 min.
Tokens: 976 input, 1,234 output
Artifacts: 1 (endpoint-code.ts)
```

---

### `orchestrator task list`

Lista tasks (filtrable por status).

**Sinopsis**:

```bash
orchestrator task list [--status <status>] [--flow <flow-id>] [--limit <n>] [--json]
```

**Flags**:

- `--status <status>`: Filtra por status (`queued`, `ready`, `running`, `waiting-waiter`, `done`, `failed`, `cancelled`).
- `--flow <flow-id>`: Filtra por flow.
- `--limit <n>`: Limita resultados (default 50).

**Ejemplo**:

```bash
npx orchestrator task list --status ready
```

**Output esperado**:

```
ID           Flow            Agent             Status    Priority   Created
task_abc123  hello-world     mateo             ready     8.0        2026-05-16 12:05
task_def456  feature-123     sofia             ready     9.5        2026-05-16 12:10
```

---

### `orchestrator task show`

Detalle de una task.

**Sinopsis**:

```bash
orchestrator task show <task-id> [--json]
```

**Ejemplo**:

```bash
npx orchestrator task show task_abc123
```

**Output esperado**:

```
Task: implementar-backend (task_abc123)
Flow: hello-world (flow_xyz)
Agent: softwarefactory_mateo
Status: done
Created: 2026-05-16 12:05 UTC
Started: 2026-05-16 12:10 UTC
Finished: 2026-05-16 12:18 UTC
Duration: 8 min
Tokens: 976 input, 1,234 output
Retries: 0

Prompt:
  Crea endpoint GET /hello?name=X en Express.js que retorna {"message":"Hello, X"}

Dependencies:
  Depends on: task_def456 (revisar-arquitectura) [done]
  Depended by: task_ghi789 (escribir-tests) [queued]

Output:
  { "code": "...", "tests": "..." }

Artifacts:
  artifact_abc (endpoint-code.ts, 8.7 KB, sha256:def...)
```

---

### `orchestrator task deps`

Subgrafo de dependencias.

**Sinopsis**:

```bash
orchestrator task deps <task-id> [--depth <n>]
```

**Flags**:

- `--depth <n>`: Profundidad del arbol (default 3).

**Ejemplo**:

```bash
npx orchestrator task deps task_abc123
```

**Output esperado**:

```
task_abc123 (implementar-backend) [done]
  depends on:
    task_def456 (revisar-arquitectura) [done]
      depends on:
        task_ghi789 (disenar-ux) [done]
          depends on:
            task_jkl012 (escribir-req) [done]
  depended by:
    task_mno345 (escribir-tests) [queued]
      depended by:
        task_pqr678 (validar-cobertura) [queued]
```

---

## Waiters

### `orchestrator waiter list`

Lista waiters.

**Sinopsis**:

```bash
orchestrator waiter list [--pending] [--flow <flow-id>] [--limit <n>] [--json]
```

**Flags**:

- `--pending`: Solo waiters con `status='waiting'`.
- `--flow <flow-id>`: Filtra por flow.

**Ejemplo**:

```bash
npx orchestrator waiter list --pending
```

**Output esperado**:

```
ID          Kind                    Flow            Prompt                                Expires in
wtr_abc123  approve-architecture    hello-world     Aprobar arquitectura Express.js?      22h
wtr_def456  approve-prod-deploy     feature-123     Aprobar deploy a produccion?          18h
```

---

### `orchestrator waiter show`

Detalle de un waiter.

**Sinopsis**:

```bash
orchestrator waiter show <waiter-id> [--json]
```

(Ver ejemplo completo en guia operativa arriba.)

---

### `orchestrator waiter fulfill`

Aprueba un waiter pasivo.

**Sinopsis**:

```bash
orchestrator waiter fulfill <waiter-id> --json '<json-payload>'
```

**Ejemplo**:

```bash
npx orchestrator waiter fulfill wtr_abc123 --json '{"approved":true,"comments":"LGTM"}'
```

**Output esperado**:

```
Waiter fulfilled: wtr_abc123
Task resumed: task_def456 (revisar-arquitectura)

Flow: hello-world (flow_xyz) continues.
```

---

### `orchestrator waiter reject`

Rechaza un waiter pasivo.

**Sinopsis**:

```bash
orchestrator waiter reject <waiter-id> --reason '<reason>'
```

**Ejemplo**:

```bash
npx orchestrator waiter reject wtr_abc123 --reason "Riesgo de performance no mitigado"
```

**Output esperado**:

```
Waiter rejected: wtr_abc123
Task failed: task_def456 (revisar-arquitectura)

Flow: hello-world (flow_xyz) transitioned to failed.
```

---

## Backlog

### `orchestrator backlog list`

Lista entradas del backlog vivo.

**Sinopsis**:

```bash
orchestrator backlog list [--category <cat>] [--status <status>] [--limit <n>] [--json]
```

**Flags**:

- `--category <cat>`: Filtra por categoria (libre, ej: `feature-wait`, `integrations`, `compliance`).
- `--status <status>`: Filtra por status (`latent`, `activated`, `cancelled`, `expired`).

**Ejemplo**:

```bash
npx orchestrator backlog list --status latent
```

(Ver output en guia operativa arriba.)

---

### `orchestrator backlog show`

Detalle de una entrada.

**Sinopsis**:

```bash
orchestrator backlog show <entry-id> [--json]
```

(Ver output en guia operativa arriba.)

---

### `orchestrator backlog review`

Asistente interactivo trimestral.

**Sinopsis**:

```bash
orchestrator backlog review
```

**Ejemplo**:

```bash
npx orchestrator backlog review
```

**Output esperado** (interactivo):

```
Backlog Review (3 entries)
==========================

Entry 1/3: blg_001 (feature-wait)
  Flow: new-client-onboarding
  Created: 2026-04-01 (45 days ago)
  Last check: 2026-05-15 (not met)
  Rationale: Esperar a que cliente compre plan enterprise

  [E]xtender / [C]ancelar / [S]altar / [Q]uit? e
  Extend by how many days? 90
  ✓ Extended until 2026-08-15

Entry 2/3: blg_002 (integrations)
  ...
```

---

### `orchestrator backlog extend`

Extiende vida de entrada.

**Sinopsis**:

```bash
orchestrator backlog extend <entry-id> --days <n>
```

**Ejemplo**:

```bash
npx orchestrator backlog extend blg_001 --days 90
```

**Output esperado**:

```
Backlog entry blg_001 extended by 90 days.
New expiration: 2026-08-15
```

---

### `orchestrator backlog cancel`

Cancela entrada.

**Sinopsis**:

```bash
orchestrator backlog cancel <entry-id> --reason '<reason>'
```

**Ejemplo**:

```bash
npx orchestrator backlog cancel blg_001 --reason "Cliente cancelo contrato"
```

**Output esperado**:

```
Backlog entry blg_001 cancelled.
Flow flow_xyz transitioned to cancelled.
```

---

### `orchestrator backlog wake`

Fuerza despertar (skip condicion).

**Sinopsis**:

```bash
orchestrator backlog wake <entry-id>
```

**Ejemplo**:

```bash
npx orchestrator backlog wake blg_001
```

**Output esperado**:

```
WARNING: Skipping waiter condition validation.
Backlog entry blg_001 woken.
Flow flow_xyz transitioned to running.

This bypasses the waiter. Use only for debugging.
```

---

## Observabilidad

### `orchestrator logs`

Tail de eventos JSONL filtrados.

**Sinopsis**:

```bash
orchestrator logs <flow-id|task-id> [--follow] [--limit <n>]
```

**Flags**:

- `--follow`: Tail continuo (como `tail -f`).
- `--limit <n>`: Ultimas N lineas (default 50).

**Ejemplo**:

```bash
npx orchestrator logs flow_abc123 --follow
```

**Output esperado**:

```
2026-05-16 14:30:10  flow.created        flow_abc123
2026-05-16 14:30:15  task.queued         task_def (escribir-req)
2026-05-16 14:30:20  task.started        task_def
2026-05-16 14:40:30  task.finished       task_def (10 min, 1,234 tokens)
2026-05-16 14:40:35  task.queued         task_ghi (disenar-ux)
...
```

---

### `orchestrator budget show`

Resumen de costos y budget.

**Sinopsis**:

```bash
orchestrator budget show [--period <today|week|month>] [--json]
```

(Ver output en guia operativa arriba.)

---

### `orchestrator budget set`

Ajusta limite diario de tokens.

**Sinopsis**:

```bash
orchestrator budget set --daily <tokens>
```

**Ejemplo**:

```bash
npx orchestrator budget set --daily 100000
```

**Output esperado**:

```
Budget updated.
Daily limit: 100,000 tokens (was 50,000)
```

---

### `orchestrator deadlock check`

Detector de ciclos en dependencias.

**Sinopsis**:

```bash
orchestrator deadlock check [--fix]
```

**Flags**:

- `--fix`: Intenta resolver ciclos (experimental, usa con cuidado).

**Ejemplo**:

```bash
npx orchestrator deadlock check
```

**Output esperado (sin ciclos)**:

```
Checking for deadlocks...
No cycles detected. All dependencies resolve.
```

**Output esperado (con ciclos)**:

```
WARNING: Cycle detected!

  task_A → task_B → task_C → task_A

Tasks involved:
  task_A (implementar-backend, flow_xyz)
  task_B (escribir-tests, flow_xyz)
  task_C (deploy-staging, flow_xyz)

This cycle prevents all 3 tasks from running.

Resolution:
  1. Review dependencies in src/flows/xyz.flow.ts
  2. Break the cycle by removing one dependency
  3. Re-run: npx orchestrator sprint plan --validate
```

---

## Recursos

- [Spec completa (v0.8.1)](../spec.md)
- [Glosario](../GLOSSARY.md)
- [Guia: operar el orquestador](../guides/operating-the-orchestrator.md)
- [Guia: escribir un flow](../guides/writing-a-flow.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
