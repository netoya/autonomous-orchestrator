// DAO para la tabla agent_sessions.
// Gestion de reutilizacion de sesiones Claude Code CLI.

import type Database from 'better-sqlite3';
import { now } from '../../lib/clock.js';

export interface AgentSessionRow {
  strategy_key: string;
  session_id: string;
  flow_id: string;
  agent_id: string;
  task_id: string | null;
  strategy: 'flow-agent-task' | 'none';
  created_at: number;
  last_used_at: number;
  turn_count: number;
}

export interface UpsertSessionInput {
  strategy_key: string;
  session_id: string;
  flow_id: string;
  agent_id: string;
  task_id: string | null;
  strategy: 'flow-agent-task' | 'none';
}

/**
 * Busca una sesion existente por strategy_key.
 * Retorna null si no existe o si ya supero el limite de turnos.
 *
 * @param db - Database instance
 * @param strategyKey - Clave unica de estrategia (ej: "flow123:agent456:task789")
 * @param maxTurns - Limite de turnos antes de forzar rotacion
 * @returns Session ID si existe y no supero el cap, null en caso contrario
 */
export function lookupSession(
  db: Database.Database,
  strategyKey: string,
  maxTurns: number
): { session_id: string } | null {
  const stmt = db.prepare(`
    SELECT session_id, turn_count
    FROM agent_sessions
    WHERE strategy_key = ?
  `);

  const row = stmt.get(strategyKey) as { session_id: string; turn_count: number } | undefined;

  if (!row) {
    return null;
  }

  // Rotacion por cap: si ya supero el limite, retornar null para forzar nueva sesion
  if (row.turn_count >= maxTurns) {
    return null;
  }

  return { session_id: row.session_id };
}

/**
 * Inserta o actualiza una sesion.
 * Pattern upsert: INSERT ... ON CONFLICT DO UPDATE.
 * Si el session_id cambia (rotacion), resetea turn_count a 1.
 * Si el session_id es el mismo, incrementa turn_count y actualiza last_used_at.
 *
 * @param db - Database instance
 * @param input - Parametros de la sesion
 */
export function upsertSession(
  db: Database.Database,
  input: UpsertSessionInput
): void {
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO agent_sessions (
      strategy_key, session_id, flow_id, agent_id, task_id, strategy,
      created_at, last_used_at, turn_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(strategy_key) DO UPDATE SET
      session_id   = excluded.session_id,
      last_used_at = excluded.last_used_at,
      turn_count   = CASE
        WHEN agent_sessions.session_id = excluded.session_id THEN agent_sessions.turn_count + 1
        ELSE 1
      END
  `);

  stmt.run(
    input.strategy_key,
    input.session_id,
    input.flow_id,
    input.agent_id,
    input.task_id,
    input.strategy,
    timestamp,
    timestamp
  );
}
