-- Tablas core del orquestador.
-- Incluye flows, tasks, executions, events, agents.
-- Incluye trigger tasks_done_trigger.
-- Nota: schema_migrations es creada por el migration runner, NO la creamos aqui.

CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','hibernated','completed','failed','cancelled')),
  autonomy TEXT NOT NULL DEFAULT 'L3',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  budget_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  parent_task_id TEXT,
  stage TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','ready','running','waiting-waiter','done','failed','cancelled')),
  input_json TEXT NOT NULL,
  output_json TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error TEXT,

  -- Coordinacion reactiva (v0.4)
  priority INTEGER NOT NULL DEFAULT 0,
  business_value INTEGER,
  estimated_minutes INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_milestone INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key);
CREATE INDEX tasks_status_idx ON tasks(status, priority DESC, created_at);
CREATE INDEX tasks_flow_idx ON tasks(flow_id, status);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0
);

-- Cola interna de eventos (escrita por triggers, leida por dispatcher tick E).
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX events_consumed_idx ON events(consumed, id);
-- Indice para queries de logs (refinamiento v0.8.1 de 3.6.4).
CREATE INDEX idx_events_logs ON events(kind, ts, payload_json);

-- Tabla de agentes.
-- Campo `role` requerido por refinamiento v0.8.1 de 3.6.2.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT CHECK(role IN ('coordinator', NULL))
);

-- Trigger que publica evento task.finished cuando una task pasa a done.
-- Usado por tick E para activar tasks dependientes.
CREATE TRIGGER tasks_done_trigger
AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status <> 'done'
BEGIN
  INSERT INTO events(ts, kind, payload_json)
  VALUES (
    unixepoch('now') * 1000,
    'task.finished',
    json_object(
      'task_id', NEW.id,
      'flow_id', NEW.flow_id,
      'stage', NEW.stage,
      'agent_id', NEW.agent_id,
      'tags', NEW.tags_json
    )
  );
END;
