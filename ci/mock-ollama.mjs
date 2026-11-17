// Fake Ollama server for CI. It knows the right answer for every test message,
// except three planted faults that the workflow's guardrails must catch:
//   en03 -> the model replies with chatty text instead of JSON
//   en10 -> the model invents a category that does not exist
//   en19 -> the server crashes (HTTP 500)
// It also serves the test set file, so the eval workflow can download it,
// and fakes the Telegram Bot API (point the Telegram credential's Base URL here)
// so CI can check which Telegram messages the intake workflow sends.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 11434);
const testsetPath = new URL('../tests/testset.jsonl', import.meta.url);
const raw = fs.readFileSync(testsetPath, 'utf8');
const byText = new Map(
  raw.trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.text, r]),
);
export const FAULTS = { en03: 'bad_json', en10: 'bad_category', en19: 'http_500' };

const reply = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const telegramLog = [];
// A real CPU model answers one request at a time, so the workflow must not fire
// them all at once. Track the most requests ever open together.
let inFlight = 0;
let maxInFlight = 0;
let telegramWebhook = null; // what n8n's Telegram Trigger registered with setWebhook

// Real Telegram rejects a message whose Markdown is broken ("can't parse entities").
// Same check here, so CI catches unescaped _ * ` [ in the texts the workflow builds.
function markdownProblem(text) {
  const t = String(text).replace(/\\[_*`\[]/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '');
  for (const ch of ['_', '*', '`']) if (t.split(ch).length % 2 === 0) return `unbalanced ${ch}`;
  if (t.includes('[')) return 'unescaped [';
  return null;
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_stats') return reply(res, 200, { maxInFlight });
  if (req.method === 'GET' && req.url === '/_telegram') return reply(res, 200, { messages: telegramLog, webhook: telegramWebhook });
  const tg = req.url.match(/^\/bot[^/]+\/(\w+)/);
  if (tg) {
    let b = '';
    req.on('data', (c) => (b += c));
    return req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const method = tg[1];
      if (method === 'setWebhook') { telegramWebhook = body; return reply(res, 200, { ok: true, result: true }); }
      if (method === 'getWebhookInfo') return reply(res, 200, { ok: true, result: { url: telegramWebhook?.url ?? '' } });
      if (method === 'deleteWebhook') { telegramWebhook = null; return reply(res, 200, { ok: true, result: true }); }
      if (method !== 'sendMessage') return reply(res, 200, { ok: true, result: true });
      const bad = body.parse_mode === 'Markdown' && markdownProblem(body.text);
      telegramLog.push({ chat_id: String(body.chat_id ?? ''), text: body.text ?? '', parse_mode: body.parse_mode, buttons: body.reply_markup?.inline_keyboard?.[0] ?? null, rejected: bad || undefined });
      if (bad) return reply(res, 400, { ok: false, error_code: 400, description: `Bad Request: can't parse entities (${bad})` });
      reply(res, 200, { ok: true, result: { message_id: telegramLog.length, chat: { id: body.chat_id }, text: body.text } });
    });
  }
  if (req.method === 'GET' && req.url === '/testset.jsonl') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(raw);
  }
  if (req.method !== 'POST' || req.url !== '/api/chat') return reply(res, 404, { error: 'not found' });
  let body = '';
  req.on('data', (c) => (body += c));
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  req.on('end', async () => {
    await new Promise((r) => setTimeout(r, 50)); // pretend to think, so overlapping calls would show
    inFlight--;
    const msgs = JSON.parse(body).messages || [];
    const text = msgs.at(-1)?.content ?? '';
    const row = byText.get(text);
    const fault = row && FAULTS[row.id];
    if (fault === 'http_500') return reply(res, 500, { error: 'model crashed' });
    let content;
    if (fault === 'bad_json') content = 'Sure! This looks like a product question to me.';
    else {
      const out = {
        category: fault === 'bad_category' ? 'shipping' : row?.category ?? 'other',
        urgency: row?.urgency ?? 'low',
        confidence: row ? 0.9 : 0.4,
        summary: 'mock summary',
        reply_draft: 'Sorry about order_4471, we *will* check [today].', // markdown traps on purpose
      };
      content = JSON.stringify(out);
    }
    reply(res, 200, { model: 'mock', message: { role: 'assistant', content }, done: true });
  });
}).listen(PORT, () => console.log(`mock ollama on :${PORT}`));
