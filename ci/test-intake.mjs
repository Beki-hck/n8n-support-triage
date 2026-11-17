// Sends real requests to the Intake workflow (website webhook AND Telegram bot)
// and checks where every message goes, including the owner's approval click.
// Needs: n8n running with the CI build imported (ci/start-n8n.sh) and ci/mock-ollama.mjs.
const N8N = process.env.N8N_URL || 'http://127.0.0.1:5678';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:11434';
const OWNER = 'REPLACE_WITH_OWNER_TELEGRAM_CHAT_ID';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('ok ', m);
const tgState = async () => (await fetch(`${MOCK}/_telegram`)).json();
const web = (body) => fetch(`${N8N}/webhook/triage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- 1. Website form: the reply says where each message was routed
const webCases = [
  { text: 'I paid 2,500 birr with Telebirr but the order still says unpaid. Transaction ID 9A7K2LQ.', route: 'urgent' },
  { text: 'ሰላም፣ ትዕዛዜ መቼ ይደርሳል? ሰኞ ነበር ያዘዝኩት።', route: 'auto', lang: 'am' },
  { text: 'Hello_there, can *someone* call me back? [urgent]', route: 'needs_human' }, // mock is unsure; Markdown traps
  { text: 'CONGRATULATIONS! You won a free iPhone 16. Click bit.ly/fr33-ph0ne to claim now!!!', route: 'spam' },
];
const start = (await tgState()).messages.length;
for (const c of webCases) {
  const res = await web({ text: c.text, from: 'Web_user' });
  if (res.status !== 200) fail(`website got HTTP ${res.status}`);
  const r = await res.json();
  if (r.route !== c.route) fail(`"${c.text.slice(0, 30)}" routed to ${r.route}, expected ${c.route}`);
  if (c.lang && r.lang !== c.lang) fail(`language detected as ${r.lang}, expected ${c.lang}`);
  if (Object.keys(r).some((k) => k.startsWith('cfg_') || k.startsWith('tg_'))) fail('internal fields leaked into the website reply');
  if ('reply_draft' in r || 'summary' in r || !r.message) fail('website must get a fixed thank-you, never AI text');
  ok(`web      ${c.route.padEnd(11)} ${c.text.slice(0, 40)}`);
}
const empty = await web({ text: '   ' });
if (empty.status !== 400) fail(`empty message returned ${empty.status}, expected 400`);
ok('web      empty message -> HTTP 400');

// ---- 2. Telegram bot: post updates the way Telegram does
const { webhook } = await tgState();
if (!webhook?.url) fail('Telegram Trigger never registered its webhook');
const hookUrl = webhook.url.replace(/^https?:\/\/[^/]+/, N8N);
let updateId = 1;
const tgSend = (chatId, message) => fetch(hookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhook.secret_token ?? '' },
  body: JSON.stringify({ update_id: updateId++, message: { message_id: updateId, chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Almaz_T' }, date: 1, ...message } }),
});
await tgSend(1001, { text: 'The dress I received is torn at the side. This is very disappointing.' }); // urgent
await tgSend(1002, { text: 'ሰላም፣ ትዕዛዜ መቼ ይደርሳል? ሰኞ ነበር ያዘዝኩት።' });                        // auto, Amharic
await tgSend(1003, { photo: [{ file_id: 'x' }] });                                                   // photo, no caption
await sleep(4000);

// ---- 3. Owner taps "Send reply" on the urgent approval request
let { messages } = await tgState();
const approval = messages.slice(start).find((m) => m.buttons && m.text.includes('torn'));
if (!approval) fail('owner never got the approval request for the Telegram complaint');
const approveBtn = approval.buttons.find((b) => b.text.includes('Send reply'));
if (!approveBtn?.url) fail(`approval buttons look wrong: ${JSON.stringify(approval.buttons)}`);
// n8n ignores link-preview bots, so the click must look like a real browser.
const click = await fetch(approveBtn.url.replace(/^https?:\/\/[^/]+/, N8N), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36' } });
if (click.status >= 400 || !(await click.text()).length) fail(`approval click failed (HTTP ${click.status})`);
ok('telegram owner tapped "Send reply"');
await sleep(4000);

// ---- 4. Error workflow: break the Eval workflow on purpose (missing test set file)
const broken = await fetch(`${N8N}/webhook/triage-eval?testset_url=${encodeURIComponent(`${MOCK}/no-such-file`)}`);
if (broken.status < 500) fail(`broken eval returned ${broken.status}, expected a failure`);
await sleep(4000);

// ---- 5. Check every Telegram message that was sent
({ messages } = await tgState());
const sent = messages.slice(start);
const rejected = sent.filter((m) => m.rejected);
if (rejected.length) fail(`Telegram would reject ${rejected.length} message(s): ${JSON.stringify(rejected)}`);
const to = (chat, needle) => sent.some((m) => m.chat_id === String(chat) && m.text.includes(needle));
const checks = [
  [to(OWNER, 'URGENT (payment) from Web\\_user via the website') && to(OWNER, 'contact this customer yourself'), 'urgent website message: owner is told to reply personally'],
  [!sent.some((m) => m.text.includes('URGENT (payment)') && m.buttons), 'no approval buttons for a reply the bot cannot deliver'],
  [to(OWNER, 'Needs you (low\\_confidence)'), 'owner gets needs-a-human alert, with Markdown escaped'],
  [to(OWNER, 'URGENT (complaint) from Almaz\\_T'), 'owner gets approval request for the Telegram complaint'],
  [to(1001, 'order\\_4471'), 'customer gets the approved AI reply after the owner taps ✅'],
  [to(1002, 'መልእክትዎ ደርሶናል'), 'Amharic customer gets the Amharic thank-you'],
  [to(OWNER, 'sent a photo, sticker or voice message'), 'photo with no text goes to a human'],
  [to(1003, 'Please also describe it'), 'photo sender is asked to describe it (English + Amharic)'],
  [to(OWNER, 'failed at node'), 'error workflow alerts the owner when a workflow crashes'],
  [!sent.some((m) => m.text.includes('iPhone')), 'spam is never forwarded'],
  [!sent.some((m) => m.chat_id === '1002' && m.text.includes('order\\_4471')), 'auto route never sends AI free text'],
];
for (const [pass, what] of checks) pass ? ok(what) : fail(what);
if (sent.length !== 8) fail(`expected exactly 8 Telegram messages, got ${sent.length}: ${JSON.stringify(sent.map((m) => m.text.slice(0, 40)))}`);
console.log('PASS: website + Telegram routing, owner approval, Markdown safety and error alerts all work');
