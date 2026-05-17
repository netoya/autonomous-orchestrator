import Database from 'better-sqlite3';
const db = new Database('/home/angel/projects/autonomous-orchestrator/state/orchestrator.db', { readonly: true });
const flowId = process.argv[2];
if (!flowId) {
  console.error('usage: inspect-flow.mjs <flowId>');
  process.exit(1);
}
const tasks = db.prepare('SELECT id, stage, agent_id, status, error_message, input_json, output_json, created_at, started_at, finished_at FROM tasks WHERE flow_id = ? ORDER BY created_at').all(flowId);
for (const t of tasks) {
  console.log('---');
  console.log('id:', t.id);
  console.log('stage:', t.stage);
  console.log('agent:', t.agent_id);
  console.log('status:', t.status);
  if (t.error_message) console.log('error_message:', t.error_message);
  if (t.input_json) {
    const inp = t.input_json.length > 1200 ? t.input_json.slice(0, 1200) + '...' : t.input_json;
    console.log('input:', inp);
  }
  if (t.output_json) {
    const out = t.output_json.length > 3000 ? t.output_json.slice(0, 3000) + '...' : t.output_json;
    console.log('output:', out);
  }
}
db.close();
