// Connection helper que aplica PRAGMAs obligatorios segun spec 3.6.6.
// Todos los DAOs y el migration runner usan openDb() para obtener la conexion.

import Database from 'better-sqlite3';
import path from 'node:path';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'state/orchestrator.db');

/**
 * Abre conexion a SQLite y aplica los 6 PRAGMAs obligatorios.
 *
 * WAL es persistente (se escribe en header de la DB), los otros son per-connection.
 * Segun spec 3.6.6 + refinamiento v0.8.1.
 */
export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);

  // PRAGMAs obligatorios per-connection
  db.pragma('journal_mode = WAL');         // persistente (redundante si ya esta en WAL, pero no dana)
  db.pragma('busy_timeout = 5000');        // 5s antes de devolver SQLITE_BUSY
  db.pragma('foreign_keys = ON');          // integridad referencial
  db.pragma('synchronous = NORMAL');       // balance durability/perf
  db.pragma('temp_store = MEMORY');        // temporales en RAM
  db.pragma('cache_size = -64000');        // ~64 MB cache

  return db;
}
