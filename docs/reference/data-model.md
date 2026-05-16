# Modelo de Datos — Schema SQL completo

> **Spec**: seccion 4.1  
> **Responsable**: Mateo (schema + DAO)

---

## Diagrama ER (texto)

```
flows (1) ─── (N) tasks ─── (N) executions ─── (0..1) agent_conversations
                   │
                   ├─── (N) task_dependencies (self-join sobre tasks)
                   │
                   └─── (N) waiters ─── (N) waiter_checks
                              │
                              └─── (0..1) backlog_entries

artifacts (N) ─── (1) executions

gates (N) ─── (1) tasks

events (tabla interna, sin FK)

schema_migrations (control de migraciones)
```

---

## Tablas

### `flows`

**Proposito**: representa un flujo de trabajo completo.

```sql
CREATE TABLE flows (
  id           TEXT PRIMARY KEY,                -- ULID
  name         TEXT NOT NULL,                   -- ej: 'hello-world', 'login-feature'
  status       TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','running','hibernated','completed','failed','cancelled')),
  autonomy     TEXT NOT NULL DEFAULT 'L3',      -- L0..L5
  created_at   INTEGER NOT NULL,                -- epoch ms
  updated_at   INTEGER NOT NULL,
  budget_json  TEXT NOT NULL DEFAULT '{}'       -- { daily_tokens, total_cost_usd, etc. }
);

CREATE INDEX flows_status_idx ON flows(status, updated_at);
```

**Columnas clave**:
- `status='hibernated'`: flow pausado por waiter de `horizon='long'`. Su contexto serializado vive en `artifacts`.
- `budget_json`: limites de tokens/costo por flow.

**Relaciones**:
- `flows (1) ─── (N) tasks`

---

### `tasks`

**Proposito**: unidad de trabajo ejecutable por un agente.

```sql
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,            -- ULID
  flow_id           TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  parent_task_id    TEXT REFERENCES tasks(id),   -- si fue spawneada por coordinator
  stage             TEXT NOT NULL,               -- planning | execution | review
  agent_id          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','ready','running','waiting-waiter','done','failed','cancelled')),
  input_json        TEXT NOT NULL,
  output_json       TEXT,
  retries           INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT NOT NULL,               -- hash(flow_id, id, input_json)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  error             TEXT,
  
  -- coordinacion reactiva (v0.4)
  priority          INTEGER NOT NULL DEFAULT 0,
  business_value    INTEGER,                      -- 1..10, opcional
  estimated_minutes INTEGER,
  tags_json         TEXT NOT NULL DEFAULT '[]',  -- array de strings
  is_milestone      INTEGER NOT NULL DEFAULT 0   -- 0|1
);

CREATE UNIQUE INDEX tasks_idem      ON tasks(idempotency_key);
CREATE INDEX tasks_status_idx       ON tasks(status, priority DESC, created_at);
CREATE INDEX tasks_flow_idx         ON tasks(flow_id, status);
CREATE INDEX tasks_parent_idx       ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
```

**Estados**:
- `queued`: esperando a que el dispatcher la tome.
- `ready`: todas las dependencias cumplidas, elegible por el selector.
- `running`: ejecutandose en un agent-runner.
- `waiting-waiter`: pausada esperando input humano o condicion externa.
- `done`: completada exitosamente.
- `failed`: fallo irrecuperable.
- `cancelled`: cancelada por operador.

**Trigger**: `tasks_done_trigger` inserta en `events` cuando `status -> 'done'`.

**Relaciones**:
- `tasks (N) ─── (1) flows`
- `tasks (N) ─── (N) tasks` (via `task_dependencies`)
- `tasks (1) ─── (N) executions`

---

### `task_dependencies`

**Proposito**: grafo de dependencias entre tasks (coordinacion reactiva).

```sql
CREATE TABLE task_dependencies (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL DEFAULT 'finish-to-start'
                        CHECK(kind IN ('finish-to-start','tag-resolved')),
  resolved_via_tag     TEXT,                      -- si se declaro por tag
  created_at           INTEGER NOT NULL,
  UNIQUE(task_id, depends_on_task_id)
);

CREATE INDEX task_deps_dependent_idx ON task_dependencies(depends_on_task_id, task_id);
CREATE INDEX task_deps_task_idx      ON task_dependencies(task_id);
```

**Uso**:
- `kind='finish-to-start'`: task espera a que `depends_on_task_id` este `done`.
- `kind='tag-resolved'`: task espera a todas las tasks con cierto tag.

**Validacion**: topological sort al crear sprint para detectar ciclos.

---

### `executions`

**Proposito**: registro de cada ejecucion de una task por el agent-runner.

```sql
CREATE TABLE executions (
  id              TEXT PRIMARY KEY,               -- ULID
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT NOT NULL
                   CHECK(status IN ('running','completed','failed','timeout')),
  tokens_input    INTEGER NOT NULL DEFAULT 0,
  tokens_output   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX executions_task_idx ON executions(task_id, started_at);
```

**Relaciones**:
- `executions (N) ─── (1) tasks`
- `executions (1) ─── (0..1) agent_conversations`
- `executions (1) ─── (N) artifacts`

---

### `agent_conversations`

**Proposito**: registro de conversaciones con agentes (Claude, OpenAI, etc.). Introducida en v0.7 (ADR-001).

```sql
CREATE TABLE agent_conversations (
  id                  TEXT PRIMARY KEY,
  execution_id        TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  agent_session_id    TEXT NOT NULL,              -- session_id del backend (usado en --resume)
  backend             TEXT NOT NULL DEFAULT 'claude-code',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  total_cost_usd      REAL NOT NULL DEFAULT 0,
  num_turns           INTEGER NOT NULL DEFAULT 0,
  tokens_input        INTEGER NOT NULL DEFAULT 0,
  tokens_output       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active'
                       CHECK(status IN ('active','paused','completed','failed','budget_exceeded'))
);

CREATE INDEX agent_conv_session_idx   ON agent_conversations(agent_session_id);
CREATE INDEX agent_conv_execution_idx ON agent_conversations(execution_id);
```

**Stream completo** persistido en `state/conversations/<execution_id>.jsonl` cuando `outputFormat='stream-json'`.

---

### `waiters`

**Proposito**: primitivos de pausa/reanudacion del flujo. Soporta waiters pasivos (input-driven) y activos (poll-driven).

```sql
CREATE TABLE waiters (
  id                    TEXT PRIMARY KEY,
  flow_id               TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id               TEXT NOT NULL,
  mode                  TEXT NOT NULL DEFAULT 'passive'
                         CHECK(mode IN ('passive','active')),
  kind                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  schema_json           TEXT NOT NULL DEFAULT '{}',
  authz_json            TEXT NOT NULL DEFAULT '{}',
  timeout_ms            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'waiting'
                         CHECK(status IN ('waiting','fulfilled','rejected','timeout','invalid')),
  value_json            TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_attempt_at       INTEGER,
  fulfilled_by          TEXT,
  fulfilled_at          INTEGER,
  
  -- columnas exclusivas de modo activo
  script_path           TEXT,
  script_version        TEXT,
  condition_kind        TEXT,
  condition_params_json TEXT,
  poll_interval_ms      INTEGER NOT NULL DEFAULT 60000,
  poll_schedule_json    TEXT,
  poll_max_attempts     INTEGER NOT NULL DEFAULT 1440,
  check_count           INTEGER NOT NULL DEFAULT 0,
  consecutive_errors    INTEGER NOT NULL DEFAULT 0,
  last_check_at         INTEGER,
  last_check_result     TEXT,
  next_check_at         INTEGER,
  
  -- dimension horizon (v0.3)
  horizon               TEXT NOT NULL DEFAULT 'short'
                         CHECK(horizon IN ('short','long')),
  max_lifetime_days     INTEGER,
  context_snapshot_hash TEXT,
  
  -- lease para evitar concurrencia
  lease_until           INTEGER,
  lease_holder          TEXT
);

CREATE INDEX waiters_status_idx     ON waiters(status, expires_at);
CREATE INDEX waiters_flow_idx       ON waiters(flow_id);
CREATE INDEX waiters_active_idx     ON waiters(mode, status, next_check_at);
CREATE INDEX waiters_horizon_idx    ON waiters(horizon, status);
CREATE INDEX waiters_lease_idx      ON waiters(lease_until) WHERE lease_until IS NOT NULL;
```

**Estados**:
- `waiting`: esperando input o condicion.
- `fulfilled`: cumplido.
- `rejected`: rechazado por validacion o authz.
- `timeout`: TTL excedido.
- `invalid`: error fatal (escalado a operador).

**Relaciones**:
- `waiters (N) ─── (1) tasks`
- `waiters (1) ─── (N) waiter_checks`
- `waiters (1) ─── (0..1) backlog_entries`

---

### `waiter_checks`

**Proposito**: auditoria detallada de polls (solo waiters activos).

```sql
CREATE TABLE waiter_checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  waiter_id         TEXT NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  checked_at        INTEGER NOT NULL,
  condition_met     INTEGER NOT NULL,             -- 0 | 1
  duration_ms       INTEGER NOT NULL,
  error             TEXT,
  result_snapshot   TEXT                          -- JSON con valor observado
);

CREATE INDEX waiter_checks_waiter_idx ON waiter_checks(waiter_id, checked_at);
```

**Archivado**: rows mas viejos que 90 dias se mueven a `state/archive/waiter_checks/<yyyy-mm>.jsonl.gz`.

---

### `backlog_entries`

**Proposito**: registro de iniciativas latentes (backlog vivo). Introducida en v0.3.

```sql
CREATE TABLE backlog_entries (
  id                    TEXT PRIMARY KEY,
  flow_definition_id    TEXT NOT NULL,
  flow_id               TEXT REFERENCES flows(id),
  waiter_id             TEXT NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  category              TEXT NOT NULL,  -- regulatory, cost, tech-dependency, flow-dependency, market, capacity, metric, other
  context_snapshot_hash TEXT,
  horizon               TEXT NOT NULL DEFAULT 'long',
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER,
  reviewed_at           INTEGER,
  next_review_at        INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'latent'
                         CHECK(status IN ('latent','activated','cancelled','expired')),
  decision_log_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX backlog_status_idx ON backlog_entries(status, next_review_at);
CREATE INDEX backlog_review_idx ON backlog_entries(next_review_at);
CREATE INDEX backlog_flow_idx   ON backlog_entries(flow_id);
```

**Revision trimestral**: `next_review_at` default +90 dias. Comando: `orchestrator backlog review`.

---

### `artifacts`

**Proposito**: archivos generados por tasks (outputs, snapshots de contexto, planes).

```sql
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,                  -- build, context_snapshot, plan, log, etc.
  path          TEXT NOT NULL,                  -- ruta relativa a state/outbox/
  hash          TEXT NOT NULL,                  -- sha256
  meta_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX artifacts_execution_idx ON artifacts(execution_id);
CREATE INDEX artifacts_type_idx      ON artifacts(type);
```

---

### `gates`

**Proposito**: puntos de aprobacion manual (arquitectura, deploy prod, hotfix).

```sql
CREATE TABLE gates (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                      -- approve-architecture, approve-prod-deploy, approve-hotfix
  decision    TEXT NOT NULL DEFAULT 'pending'
               CHECK(decision IN ('pending','approved','rejected')),
  comments    TEXT,
  decided_at  INTEGER
);

CREATE INDEX gates_task_idx ON gates(task_id);
```

**Relacion con waiters**: un gate puede modelarse como waiter pasivo. La tabla `gates` es legacy; se mantiene para compatibilidad con el BRD.

---

### `events`

**Proposito**: cola interna de eventos (escrita por triggers SQLite, leida por tick E).

```sql
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,                    -- task.finished, task.failed, waiter.fulfilled, etc.
  payload_json TEXT NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0        -- 0=pendiente, 1=ya emitido a events.jsonl
);

CREATE INDEX events_consumed_idx ON events(consumed, id);
```

**Diferencia con `events.jsonl`**: esta tabla es **interna** (estado volatile). `events.jsonl` es **auditoria** (append-only, inmutable).

**Trigger ejemplo**:

```sql
CREATE TRIGGER tasks_done_trigger
AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status <> 'done'
BEGIN
  INSERT INTO events(ts, kind, payload_json)
  VALUES (
    strftime('%s','now')*1000,
    'task.finished',
    json_object('task_id', NEW.id, 'flow_id', NEW.flow_id, 'stage', NEW.stage, 'agent_id', NEW.agent_id, 'tags', NEW.tags_json)
  );
END;
```

---

### `schema_migrations`

**Proposito**: control de migraciones SQL forward-only.

```sql
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
```

**Uso**: el migration runner inserta una fila por cada `.sql` ejecutado. El `checksum` valida que el archivo no fue modificado tras aplicarse.

---

## Indices

Indices criticos por performance:

| Tabla | Indice | Razon |
|-------|--------|-------|
| `tasks` | `tasks_status_idx (status, priority DESC, created_at)` | Selector WSJF en tick A |
| `waiters` | `waiters_active_idx (mode, status, next_check_at)` | Scheduler de waiters activos |
| `events` | `events_consumed_idx (consumed, id)` | Consumer de eventos en tick E |
| `task_dependencies` | `task_deps_dependent_idx (depends_on_task_id, task_id)` | Busqueda de dependientes |

---

## Triggers

| Trigger | Tabla | Accion | Proposito |
|---------|-------|--------|-----------|
| `tasks_done_trigger` | `tasks` | AFTER UPDATE OF status | Inserta evento `task.finished` en `events` |
| (futuros) | `flows` | AFTER UPDATE OF status | Emitir eventos de flow completion |

---

## Referencias

- **Spec seccion 4.1**: Esquema SQL completo
- **Spec seccion 3.6.5**: Sistema de migraciones
- **Spec seccion 3.6.6**: PRAGMAs SQLite
- **ARCHITECTURE.md**: Diagrama de capas
