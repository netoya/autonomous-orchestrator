-- Tabla agent_sessions para reutilizacion de sesiones Claude Code CLI.
-- Asume single-dispatcher. Si en el futuro corren 2 dispatchers concurrentes,
-- el upsert puede tener race conditions (SQLite con WAL no serializa writes entre procesos).

CREATE TABLE IF NOT EXISTS agent_sessions (
  strategy_key TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  task_id      TEXT,             -- nullable para futuros modos como flow-agent
  strategy     TEXT NOT NULL,    -- 'flow-agent-task' | 'none'
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  turn_count   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS agent_sessions_flow_idx ON agent_sessions(flow_id);
CREATE INDEX IF NOT EXISTS agent_sessions_task_idx ON agent_sessions(task_id) WHERE task_id IS NOT NULL;
