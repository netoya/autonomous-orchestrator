-- Migration 009: añadir executions.child_pid para tracking cross-restart del PID
-- del proceso `claude -p` spawneado por el dispatcher.
--
-- Motivación: handleFlowCancelled mata PIDs leyendo de this.childPids (state
-- in-memory). Si el dispatcher reinicia tras spawn pero antes de cancel, el
-- state se pierde y el child queda zombi. Persistir el pid en DB permite que
-- cancel funcione cross-restart.
--
-- NULLABLE: ejecuciones legadas tienen child_pid = NULL.
-- El pid se setea justo despues del spawn, y queda en DB incluso tras child
-- exit — el discriminante "vivo" es finished_at IS NULL.

ALTER TABLE executions
  ADD COLUMN child_pid INTEGER;

CREATE INDEX IF NOT EXISTS executions_running_pid_idx
  ON executions(task_id, child_pid)
  WHERE finished_at IS NULL AND child_pid IS NOT NULL;
