#!/usr/bin/env tsx
// Migration runner con subcomandos: up, status, reset.
// Logica forward-only segun spec 3.6.5 + refinamiento v0.8.1.

import { openDb } from '../db/connection.js';
import { sha256 } from '../lib/sha256.js';
import { readFileSync, readdirSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');
const STATE_DIR = path.resolve(process.cwd(), 'state');
const LOCK_FILE = path.join(STATE_DIR, '.migration.lock');
const LOCK_TIMEOUT_MS = 30_000;

interface MigrationRecord {
  name: string;
  applied_at: string;
  checksum: string;
}

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const stat = readFileSync(LOCK_FILE, 'utf-8');
    const lockTime = parseInt(stat, 10);
    const elapsed = Date.now() - lockTime;

    if (elapsed < LOCK_TIMEOUT_MS) {
      console.error(`Migration lock held by another process. Waiting...`);
      throw new Error('MigrationLockTimeout');
    }

    // Lock antiguo (proceso muerto), lo borramos
    console.warn('Stale migration lock detected, removing.');
    unlinkSync(LOCK_FILE);
  }

  writeFileSync(LOCK_FILE, Date.now().toString(), 'utf-8');
}

function releaseLock(): void {
  if (existsSync(LOCK_FILE)) {
    unlinkSync(LOCK_FILE);
  }
}

function ensureSchemaTable(db: ReturnType<typeof openDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
}

function getAppliedMigrations(db: ReturnType<typeof openDb>): MigrationRecord[] {
  return db.prepare('SELECT name, applied_at, checksum FROM schema_migrations ORDER BY id').all() as MigrationRecord[];
}

function getMigrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function runMigrationUp(): void {
  const dbPath = process.env.DB_PATH || path.join(STATE_DIR, 'orchestrator.db');
  const db = openDb(dbPath);

  try {
    acquireLock();

    // Asegurar que existe tabla schema_migrations
    ensureSchemaTable(db);

    const applied = new Map(getAppliedMigrations(db).map(m => [m.name, m]));
    const files = getMigrationFiles();

    for (const file of files) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = readFileSync(filePath, 'utf-8');
      const checksum = sha256(sql);

      if (applied.has(file)) {
        // Ya aplicada, verificar checksum
        const record = applied.get(file)!;
        if (record.checksum !== checksum) {
          throw new Error(`MigrationTamperedError: ${file} has different checksum. Expected ${record.checksum}, got ${checksum}.`);
        }
        console.log(`[SKIP] ${file} (already applied)`);
        continue;
      }

      // Ejecutar migracion dentro de transaccion
      console.log(`[RUN]  ${file}`);
      const tx = db.transaction(() => {
        db.exec(sql);
        db.prepare(`
          INSERT INTO schema_migrations (name, applied_at, checksum)
          VALUES (?, datetime('now'), ?)
        `).run(file, checksum);
      });

      tx();
      console.log(`[OK]   ${file}`);
    }

    console.log('All migrations applied successfully.');
  } finally {
    db.close();
    releaseLock();
  }
}

function runMigrationStatus(): void {
  const dbPath = process.env.DB_PATH || path.join(STATE_DIR, 'orchestrator.db');

  if (!existsSync(dbPath)) {
    console.log('No database found. Run `npm run migrate` to initialize.');
    return;
  }

  const db = openDb(dbPath);
  try {
    ensureSchemaTable(db);
    const applied = getAppliedMigrations(db);
    const files = getMigrationFiles();

    console.log('\nMigration Status:\n');
    console.log('NAME                          | APPLIED AT          | CHECKSUM');
    console.log('------------------------------|---------------------|------------------');

    for (const file of files) {
      const record = applied.find(m => m.name === file);
      if (record) {
        console.log(`${file.padEnd(30)}| ${record.applied_at.padEnd(20)}| ${record.checksum.slice(0, 16)}...`);
      } else {
        console.log(`${file.padEnd(30)}| PENDING             | -`);
      }
    }

    console.log('\n');
  } finally {
    db.close();
  }
}

function runMigrationReset(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('migrate:reset is NOT allowed in NODE_ENV=production');
  }

  const dbPath = process.env.DB_PATH || path.join(STATE_DIR, 'orchestrator.db');

  console.warn('Resetting database...');

  // Borrar archivos DB
  [dbPath, `${dbPath}-shm`, `${dbPath}-wal`].forEach(f => {
    if (existsSync(f)) {
      unlinkSync(f);
      console.log(`[DELETE] ${f}`);
    }
  });

  // Re-aplicar todas las migraciones
  runMigrationUp();
}

// Main
const command = process.argv[2];

switch (command) {
  case 'up':
    runMigrationUp();
    break;
  case 'status':
    runMigrationStatus();
    break;
  case 'reset':
    runMigrationReset();
    break;
  default:
    console.error('Usage: tsx src/cli/migrate.ts <up|status|reset>');
    process.exit(1);
}
