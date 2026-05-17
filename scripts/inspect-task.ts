import { openDb } from '../src/db/connection.js';
const db = openDb();
const flowId = '01KRSYXE0QEP4VPF10SDPZHWR4';

const tasks = db.prepare(`
  SELECT id, stage, agent_id, status, priority, error, input_json, output_json, created_at, updated_at
  FROM tasks WHERE flow_id = ?
  ORDER BY priority DESC, created_at ASC
`).all(flowId) as any[];

for (const t of tasks) {
  console.log('=== TASK:', t.stage, '| status:', t.status, '| agent:', t.agent_id, '| id:', t.id);
  if (t.error) console.log('  ERROR:', t.error);
  const input = JSON.parse(t.input_json || '{}');
  console.log('  max_turns:', input.max_turns);
  console.log('  message:', (input.message || '').slice(0, 600));
  if (t.output_json) {
    console.log('  output:', t.output_json.slice(0, 600));
  }
  console.log();
}

console.log('=== DEPENDENCIES ===');
const deps = db.prepare(`
  SELECT t1.stage AS task, t2.stage AS depends_on
  FROM task_dependencies td
  JOIN tasks t1 ON t1.id = td.task_id
  JOIN tasks t2 ON t2.id = td.depends_on_task_id
  WHERE t1.flow_id = ?
`).all(flowId) as any[];
for (const d of deps) console.log(' ', d.task, '<-', d.depends_on);

db.close();
