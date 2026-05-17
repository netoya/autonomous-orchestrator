import Database from 'better-sqlite3';
const db = new Database('/home/angel/projects/autonomous-orchestrator/state/orchestrator.db', { readonly: true });
const flowId = process.argv[2] || '01KRSPQAMKPQ6CZEN1FBK9PY7G';
const rows = db.prepare('SELECT id, stage, agent_id, status, error, retries FROM tasks WHERE flow_id = ? ORDER BY created_at').all(flowId);
console.log('TASKS:');
console.log(JSON.stringify(rows, null, 2));
try {
  const deps = db.prepare(`SELECT t1.stage as task, t2.stage as depends_on FROM task_dependencies td JOIN tasks t1 ON t1.id=td.task_id JOIN tasks t2 ON t2.id=td.depends_on_task_id WHERE t1.flow_id=?`).all(flowId);
  console.log('\nDEPS:');
  console.log(JSON.stringify(deps, null, 2));
} catch (e) { console.log('deps query failed:', e.message); }
db.close();
