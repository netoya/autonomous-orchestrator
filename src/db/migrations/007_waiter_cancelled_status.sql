-- Migration 007: añadir 'cancelled' al CHECK constraint de waiters.status.
-- Necesario para `flow cancel` con cascada (ADR-006).
--
-- SQLite no permite ALTER del CHECK constraint directamente.
-- Patrón estándar: crear tabla nueva con el CHECK ampliado, copiar datos, drop la vieja, rename.
-- Las 36 columnas se listan explícitamente para sincronizar con el schema actual
-- (resultado acumulado de migrations 002 + 003 + 005 + parches del refinamiento v0.8.1).
--
-- NOTA: el migration runner ya envuelve cada archivo en una transacción.
-- No usar BEGIN TRANSACTION / COMMIT aquí (nested transaction error).

-- 1. Crear waiters_new con TODAS las 36 columnas + el CHECK ampliado (añade 'cancelled').
CREATE TABLE waiters_new (
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
    CHECK(status IN ('waiting','fulfilled','rejected','timeout','invalid','cancelled')),
  value_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  fulfilled_by TEXT,
  fulfilled_at INTEGER,
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
  horizon TEXT NOT NULL DEFAULT 'short'
    CHECK(horizon IN ('short','long')),
  max_lifetime_days INTEGER,
  context_snapshot_hash TEXT,
  lease_until INTEGER,
  lease_holder TEXT,
  last_checked INTEGER
);

-- 2. Copiar datos columna por columna (orden explícito).
INSERT INTO waiters_new (
  id, flow_id, task_id, step_id, mode, kind, prompt, schema_json, authz_json,
  timeout_ms, created_at, expires_at, status, value_json, attempts,
  last_attempt_at, fulfilled_by, fulfilled_at, script_path, script_version,
  condition_kind, condition_params_json, poll_interval_ms, poll_schedule_json,
  poll_max_attempts, check_count, consecutive_errors, last_check_at,
  last_check_result, next_check_at, horizon, max_lifetime_days,
  context_snapshot_hash, lease_until, lease_holder, last_checked
)
SELECT
  id, flow_id, task_id, step_id, mode, kind, prompt, schema_json, authz_json,
  timeout_ms, created_at, expires_at, status, value_json, attempts,
  last_attempt_at, fulfilled_by, fulfilled_at, script_path, script_version,
  condition_kind, condition_params_json, poll_interval_ms, poll_schedule_json,
  poll_max_attempts, check_count, consecutive_errors, last_check_at,
  last_check_result, next_check_at, horizon, max_lifetime_days,
  context_snapshot_hash, lease_until, lease_holder, last_checked
FROM waiters;

-- 3. Drop tabla vieja y rename.
DROP TABLE waiters;
ALTER TABLE waiters_new RENAME TO waiters;

-- 4. Recrear los 5 índices originales.
CREATE INDEX waiters_status_idx ON waiters(status, expires_at);
CREATE INDEX waiters_flow_idx ON waiters(flow_id);
CREATE INDEX waiters_active_idx ON waiters(mode, status, next_check_at);
CREATE INDEX waiters_horizon_idx ON waiters(horizon, status);
CREATE INDEX waiters_lease_idx ON waiters(lease_until) WHERE lease_until IS NOT NULL;
