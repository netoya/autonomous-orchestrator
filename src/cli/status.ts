// Subcomando: orchestrator status
// Muestra estado global del sistema.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { openDb } from '../db/connection.js';
import { listPendingEvents } from '../db/dao/events.js';

export default async function status(args: string[]): Promise<void> {
  const db = openDb();

  // Counts por estado de flows
  const flowStats = db
    .prepare(
      `SELECT status, COUNT(*) as count
       FROM flows
       GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;

  // Counts por estado de tasks
  const taskStats = db
    .prepare(
      `SELECT status, COUNT(*) as count
       FROM tasks
       GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;

  // Ultimos 5 eventos pendientes
  const recentEvents = listPendingEvents(db, 5);

  // Heartbeat age
  const heartbeatPath = 'state/.heartbeat';
  let heartbeatAge = 'N/A';
  if (existsSync(heartbeatPath)) {
    const hbTimestamp = parseInt(readFileSync(heartbeatPath, 'utf8').trim(), 10);
    const ageMs = Date.now() - hbTimestamp;
    heartbeatAge = `${Math.floor(ageMs / 1000)}s ago`;
  }

  // Output
  console.log('=== Orchestrator Status ===\n');

  console.log('Flows:');
  if (flowStats.length === 0) {
    console.log('  (none)');
  } else {
    for (const s of flowStats) {
      console.log(`  ${s.status}: ${s.count}`);
    }
  }

  console.log('\nTasks:');
  if (taskStats.length === 0) {
    console.log('  (none)');
  } else {
    for (const s of taskStats) {
      console.log(`  ${s.status}: ${s.count}`);
    }
  }

  console.log('\nRecent Events (pending):');
  if (recentEvents.length === 0) {
    console.log('  (none)');
  } else {
    for (const e of recentEvents) {
      const ts = new Date(e.ts).toISOString();
      console.log(`  [${e.id}] ${ts} ${e.kind}`);
    }
  }

  console.log(`\nHeartbeat: ${heartbeatAge}`);

  db.close();
}
