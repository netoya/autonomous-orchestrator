import { openDb } from '../src/db/connection.js';

const db = openDb();
const rows = db.prepare('SELECT id, stage, agent_id, status, error, retries, input_json FROM tasks WHERE flow_id = ?').all('01KRSMJ4VE7N1HGA0NGEBN9FEX');
console.log(JSON.stringify(rows, null, 2));
db.close();
