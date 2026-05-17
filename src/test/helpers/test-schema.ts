// Helper para crear schema minimo de tests del dispatcher.
// Incluye todas las tablas necesarias para los tests sin aplicar migraciones completas.

import type Database from 'better-sqlite3';

export function createTestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      status TEXT NOT NULL DEFAULT 'queued',
      autonomy TEXT NOT NULL DEFAULT 'L3',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      budget_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      parent_task_id TEXT,
      stage TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      input_json TEXT NOT NULL,
      output_json TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      business_value INTEGER,
      estimated_minutes INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_milestone INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'finish-to-start',
      resolved_via_tag TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE waiters (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      authz_json TEXT NOT NULL DEFAULT '{}',
      timeout_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      value_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      fulfilled_by TEXT,
      fulfilled_at INTEGER,
      script_path TEXT,
      script_version TEXT,
      condition_kind TEXT,
      condition_params_json TEXT,
      poll_interval_ms INTEGER NOT NULL DEFAULT 5000,
      poll_schedule_json TEXT,
      poll_max_attempts INTEGER NOT NULL DEFAULT 100,
      check_count INTEGER NOT NULL DEFAULT 0,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      last_check_at INTEGER,
      last_check_result TEXT,
      next_check_at INTEGER,
      horizon TEXT NOT NULL DEFAULT 'short',
      max_lifetime_days INTEGER,
      context_snapshot_hash TEXT,
      lease_until INTEGER,
      lease_holder TEXT,
      last_checked INTEGER
    );

    CREATE TABLE agent_sessions (
      strategy_key TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_id     TEXT NOT NULL,
      task_id      TEXT,
      strategy     TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      turn_count   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TRIGGER tasks_done_trigger
    AFTER UPDATE OF status ON tasks
    WHEN NEW.status = 'done' AND OLD.status <> 'done'
    BEGIN
      INSERT INTO events(ts, kind, payload_json)
      VALUES (
        strftime('%s','now')*1000,
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
  `);
}
