-- Tabla waiters (pasivos + activos) y waiter_checks.
-- Segun spec 3.3.1.

CREATE TABLE waiters (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'passive'
    CHECK(mode IN ('passive','active')),
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '{}',
  authz_json TEXT NOT NULL DEFAULT '{}',
  timeout_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK(status IN ('waiting','fulfilled','rejected','timeout','invalid')),
  value_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  fulfilled_by TEXT,
  fulfilled_at INTEGER,

  -- Columnas exclusivas de modo activo
  script_path TEXT,
  script_version TEXT,
  condition_kind TEXT,
  condition_params_json TEXT,
  poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
  poll_schedule_json TEXT,
  poll_max_attempts INTEGER NOT NULL DEFAULT 1440,
  check_count INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_check_result TEXT,
  next_check_at INTEGER,

  -- Dimension horizon (v0.3)
  horizon TEXT NOT NULL DEFAULT 'short'
    CHECK(horizon IN ('short','long')),
  max_lifetime_days INTEGER,
  context_snapshot_hash TEXT,

  -- Lease para evitar concurrencia
  lease_until INTEGER,
  lease_holder TEXT,

  -- Campo last_checked del refinamiento v0.8.1 de 3.6.4 para recovery startup
  last_checked INTEGER
);

CREATE INDEX waiters_status_idx ON waiters(status, expires_at);
CREATE INDEX waiters_flow_idx ON waiters(flow_id);
CREATE INDEX waiters_active_idx ON waiters(mode, status, next_check_at);
CREATE INDEX waiters_horizon_idx ON waiters(horizon, status);
CREATE INDEX waiters_lease_idx ON waiters(lease_until) WHERE lease_until IS NOT NULL;

-- Auditoria detallada de polls (solo modo activo)
CREATE TABLE waiter_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waiter_id TEXT NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  condition_met INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  result_snapshot TEXT
);

CREATE INDEX waiter_checks_waiter_idx ON waiter_checks(waiter_id, checked_at);
