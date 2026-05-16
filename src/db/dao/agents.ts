// DAO para la tabla agents.
// ensureAgent hace insert or ignore (idempotente).

import type Database from 'better-sqlite3';

export interface AgentRow {
  id: string;
  name: string;
  role: 'coordinator' | null;
}

export interface EnsureAgentInput {
  id: string;
  name: string;
  role?: 'coordinator' | null;
}

export function ensureAgent(db: Database.Database, input: EnsureAgentInput): void {
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, role)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  stmt.run(input.id, input.name, input.role ?? null);
}

export function findAgent(db: Database.Database, id: string): AgentRow | undefined {
  const stmt = db.prepare('SELECT * FROM agents WHERE id = ?');
  return stmt.get(id) as AgentRow | undefined;
}
