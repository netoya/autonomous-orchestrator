-- Tablas gates y artifacts.
-- Segun spec seccion 4.

CREATE TABLE gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  comments TEXT,
  decided_at INTEGER
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
