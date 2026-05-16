// DAO para la tabla events.
// Cola interna de eventos usada por tick E del dispatcher.

import type Database from 'better-sqlite3';

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload_json: string;
  consumed: number;
}

export function insertEvent(
  db: Database.Database,
  kind: string,
  payload: unknown,
  ts: number
): number {
  const stmt = db.prepare(`
    INSERT INTO events (ts, kind, payload_json, consumed)
    VALUES (?, ?, ?, 0)
  `);

  const result = stmt.run(ts, kind, JSON.stringify(payload));
  return result.lastInsertRowid as number;
}

export function listPendingEvents(db: Database.Database, limit = 100): EventRow[] {
  const stmt = db.prepare('SELECT * FROM events WHERE consumed = 0 ORDER BY id LIMIT ?');
  return stmt.all(limit) as EventRow[];
}

export function markConsumed(db: Database.Database, id: number): void {
  const stmt = db.prepare('UPDATE events SET consumed = 1 WHERE id = ?');
  stmt.run(id);
}
