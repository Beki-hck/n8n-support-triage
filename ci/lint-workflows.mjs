// Static checks on the shipped workflow JSON. Runs in CI before n8n even starts.
import fs from 'node:fs';
const dir = 'workflows';
const errors = [];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const all = Object.fromEntries(files.map((f) => [f, JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))]));
const ids = new Set(Object.values(all).map((wf) => wf.id));
for (const [f, wf] of Object.entries(all)) {
  const raw = JSON.stringify(wf);
  const names = new Set(wf.nodes.map((n) => n.name));
  if (wf.nodes.some((n) => n.credentials)) errors.push(`${f}: ships with credentials attached`);
  if (/\d{8,10}:[A-Za-z0-9_-]{30,}/.test(raw)) errors.push(`${f}: looks like a Telegram bot token`);
  if (/(sk-|AIza)[A-Za-z0-9_-]{20,}/.test(raw)) errors.push(`${f}: looks like an API key`);
  const linked = new Set();
  for (const [from, c] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push(`${f}: connection from missing node "${from}"`);
    linked.add(from);
    for (const out of c.main) for (const t of out ?? []) {
      if (!names.has(t.node)) errors.push(`${f}: connection to missing node "${t.node}"`);
      linked.add(t.node);
    }
  }
  for (const n of wf.nodes)
    if (n.type !== 'n8n-nodes-base.stickyNote' && !linked.has(n.name)) errors.push(`${f}: node "${n.name}" is not connected`);
  for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow'))
    if (!ids.has(n.parameters.workflowId.value)) errors.push(`${f}: calls unknown sub-workflow ${n.parameters.workflowId.value}`);
  const isErrorWf = wf.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
  if (!isErrorWf && !ids.has(wf.settings.errorWorkflow)) errors.push(`${f}: no error workflow set`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`lint ok: ${ids.size} workflows`);
