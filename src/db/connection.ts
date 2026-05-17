// Connection helper que aplica PRAGMAs obligatorios segun spec 3.6.6.
// Todos los DAOs y el migration runner usan openDb() para obtener la conexion.

import Database from 'better-sqlite3';
import path from 'node:path';

// Resolucion del path de la DB en orden de prioridad:
// 1. Path pasado como argumento explicito a openDb()
// 2. Env var ORCHESTRATOR_DB (absoluto, util cuando un agente ejecuta cli-tools.ts
//    desde otro cwd — sin esto, process.cwd() resolveria a una DB inexistente)
// 3. process.cwd() + state/orchestrator.db (default historico)
function resolveDefaultDbPath(): string {
  const fromEnv = process.env.ORCHESTRATOR_DB;
  if (fromEnv && fromEnv.length > 0) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), 'state/orchestrator.db');
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

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
