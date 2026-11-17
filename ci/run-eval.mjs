// Calls the Eval workflow's webhook, prints the report, and checks it.
//   node ci/run-eval.mjs --mock          contract test against ci/mock-ollama.mjs (exact numbers)
//   node ci/run-eval.mjs --min 80        real model: fail if category accuracy < 80%
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const N8N = process.env.N8N_URL || 'http://127.0.0.1:5678';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:11434';
const mock = args.includes('--mock');
const min = args.includes('--min') ? Number(args[args.indexOf('--min') + 1]) : 0;
const model = process.env.MODEL || '';

const q = new URLSearchParams();
if (mock || process.env.TESTSET_URL) q.set('testset_url', process.env.TESTSET_URL || `${MOCK}/testset.jsonl`);
if (model || mock) q.set('model', model || 'mock');
if (process.env.OLLAMA_URL || mock) q.set('ollama_url', process.env.OLLAMA_URL || MOCK);

// node:http instead of fetch: a real model on a CPU can take longer than fetch's 5-minute header timeout.
const { status, body } = await new Promise((resolve, reject) => {
  http.get(`${N8N}/webhook/triage-eval?${q}`, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  }).on('error', reject);
});
if (status !== 200) throw new Error(`eval webhook returned ${status}: ${body}`);
const report = JSON.parse(body);
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(`results/report-${mock ? 'mock' : (report.model || 'model').replace(/[:/]/g, '_')}.json`, JSON.stringify(report, null, 2));
console.log(report.markdown_row);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.markdown_row}\n\n`);
const errs = report.misses.filter((m) => m.llm_error).slice(0, 3);
if (errs.length) console.log('first LLM errors:', errs.map((m) => `${m.id}: ${m.llm_error}`).join('\n  '));
console.log('guardrails:', JSON.stringify(report.guardrails), ' missed urgent:', report.missed_urgent.length);

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
if (mock) {
  // The mock answers every message correctly except 3 planted faults.
  // Each fault must be caught by a different guardrail and sent to a human.
  const expect = { n: 60, accuracy: 95, guardrails: { invalid_json: 1, unknown_category: 1, llm_unreachable: 1 } };
  if (report.n !== expect.n) fail(`n=${report.n}, expected ${expect.n}`);
  if (report.accuracy !== expect.accuracy) fail(`accuracy=${report.accuracy}, expected ${expect.accuracy}`);
  if (JSON.stringify(report.guardrails) !== JSON.stringify(expect.guardrails)) fail(`guardrails=${JSON.stringify(report.guardrails)}`);
  const caught = report.misses.every((m) => m.got === 'needs_human');
  if (!caught) fail('a planted fault slipped past the guardrails');
  if (report.missed_urgent.length) fail(`urgent messages not escalated: ${report.missed_urgent}`);
  console.log('PASS: all 3 planted faults were caught and routed to a human');
} else if (report.accuracy < min) fail(`accuracy ${report.accuracy}% < ${min}%`);
