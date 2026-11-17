// CI only: copy the workflows and attach fake Telegram / Google Sheets credentials
// (the shipped JSON has none, so you pick your own after importing).
import fs from 'node:fs';
const [src = 'workflows', out = 'ci/.build'] = process.argv.slice(2);
const CREDS = {
  'n8n-nodes-base.telegram': { telegramApi: { id: 'ciTelegram000001', name: 'CI Telegram' } },
  'n8n-nodes-base.telegramTrigger': { telegramApi: { id: 'ciTelegram000001', name: 'CI Telegram' } },
  'n8n-nodes-base.googleSheets': { googleSheetsOAuth2Api: { id: 'ciSheets00000001', name: 'CI Sheets' } },
};
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) {
  const wf = JSON.parse(fs.readFileSync(`${src}/${f}`, 'utf8'));
  for (const n of wf.nodes) if (CREDS[n.type]) n.credentials = CREDS[n.type];
  fs.writeFileSync(`${out}/${f}`, JSON.stringify(wf, null, 2));
}
const mock = process.env.MOCK_URL || 'http://localhost:11434';
fs.writeFileSync(`${out}/../.creds.json`, JSON.stringify([
  { id: 'ciTelegram000001', name: 'CI Telegram', type: 'telegramApi', data: { accessToken: '123:ci', baseUrl: mock } },
  { id: 'ciSheets00000001', name: 'CI Sheets', type: 'googleSheetsOAuth2Api', data: { clientId: 'ci', clientSecret: 'ci', oauthTokenData: { access_token: 'ci' } } },
]));
console.log(`wrote ${out}/ and ci/.creds.json`);
