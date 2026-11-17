// Sends real HTTP requests to the Intake workflow and checks where each message goes.
// Needs: n8n running with the CI build imported, and ci/mock-ollama.mjs running.
const N8N = process.env.N8N_URL || 'http://localhost:5678';
const MOCK = process.env.MOCK_URL || 'http://localhost:11434';
const post = (body) => fetch(`${N8N}/webhook/triage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

const before = (await (await fetch(`${MOCK}/_telegram`)).json()).length;

const cases = [
  { text: 'I paid 2,500 birr with Telebirr but the order still says unpaid. Transaction ID 9A7K2LQ.', route: 'urgent' },
  { text: 'ሰላም፣ ትዕዛዜ መቼ ይደርሳል? ሰኞ ነበር ያዘዝኩት።', route: 'auto', lang: 'am' },
  { text: 'Hello, can someone call me back please?', route: 'needs_human' },   // mock is unsure (confidence 0.4)
  { text: 'CONGRATULATIONS! You won a free iPhone 16. Click bit.ly/fr33-ph0ne to claim now!!!', route: 'spam' },
];
for (const c of cases) {
  const r = await (await post({ text: c.text, from: 'CI' })).json();
  if (r.route !== c.route) fail(`"${c.text.slice(0, 30)}" routed to ${r.route}, expected ${c.route}`);
  if (c.lang && r.lang !== c.lang) fail(`language detected as ${r.lang}, expected ${c.lang}`);
  if (Object.keys(r).some((k) => k.startsWith('cfg_'))) fail('settings leaked into the reply');
  console.log(`ok  ${c.route.padEnd(11)} ${c.text.slice(0, 40)}`);
}
const bad = await post({});
if (bad.status !== 500) fail(`empty message returned ${bad.status}, expected 500`);
console.log('ok  empty message rejected');

await new Promise((r) => setTimeout(r, 3000));          // let the async branches finish
const sent = (await (await fetch(`${MOCK}/_telegram`)).json()).slice(before);
const has = (s) => sent.some((m) => m.text.includes(s));
if (!has('URGENT')) fail('owner never got the approval request for the urgent message');
if (!has('Needs you')) fail('owner never got the needs-a-human alert');
if (!has('failed at node')) fail('error workflow did not alert the owner');
if (sent.length !== 3) fail(`expected 3 Telegram messages, got ${sent.length}: ${JSON.stringify(sent)}`);
console.log('PASS: routes, owner approval, human alert and error alert all work');
