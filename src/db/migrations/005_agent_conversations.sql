-- Tabla agent_conversations para tracking de sesiones Claude.
-- Segun spec seccion 4.1 (v0.7).

CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'claude-code',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','completed','failed','budget_exceeded'))
);

CREATE INDEX agent_conv_session_idx ON agent_conversations(agent_session_id);
CREATE INDEX agent_conv_execution_idx ON agent_conversations(execution_id);
