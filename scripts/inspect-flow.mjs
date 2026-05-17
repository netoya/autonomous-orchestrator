import Database from 'better-sqlite3';
const db = new Database('/home/angel/projects/autonomous-orchestrator/state/orchestrator.db', { readonly: true });
const flowId = process.argv[2] || '019E36762A6E87B72470C32744';
const tasks = db.prepare("SELECT id, stage, agent_id, status, substr(error,1,200) as err, created_at FROM tasks WHERE flow_id=? ORDER BY created_at ASC").all(flowId);
console.log(JSON.stringify(tasks, null, 2));
console.log('--- FAILED ---');
const failed = db.prepare("SELECT id, stage, agent_id, status, error, input_json, output_json FROM tasks WHERE flow_id=? AND status='failed'").all(flowId);
console.log(JSON.stringify(failed, null, 2));
