-- Tabla task_dependencies para coordinacion reactiva.
-- Segun spec seccion 4 + refinamiento v0.8.1.

CREATE TABLE task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'finish-to-start'
    CHECK(kind IN ('finish-to-start','tag-resolved')),
  resolved_via_tag TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, depends_on_task_id)
);

CREATE INDEX task_deps_dependent_idx ON task_dependencies(depends_on_task_id, task_id);
CREATE INDEX task_deps_task_idx ON task_dependencies(task_id);
