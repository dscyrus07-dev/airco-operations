// One-shot: submit new journey-template copy to Twilio Content + Meta approval.
// Usage:
//   node scripts/update-journey-templates.mjs            → create + submit, saves pending map
//   node scripts/update-journey-templates.mjs --swap     → poll approvals, swap body+SID when approved
import 'dotenv/config';
import fs from 'node:fs';
import { TEMPLATES } from '../src/templates/definitions.js';
import { getTemplateConfig, setTemplateBody, setTemplateContentSid } from '../src/templates/store.js';
import { query } from '../src/db.js';

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const PENDING_FILE = new URL('./.pending-templates.json', import.meta.url);

const EXAMPLES = {
  checkin_info: { 1: 'Cyrus', 2: '29 Sept', 3: '1:00 PM', 4: '10:00 AM' },
  welcome: { 1: 'Cyrus', 2: 'Room 103-1' },
  activity_notice: { 1: 'Cyrus', 2: 'DJ Night', 3: 'Monday, 28 Sept', 4: '9:00 PM', 5: 'Cafe Zone' },
  checkout_reminder: { 1: 'Cyrus', 2: 'Room 103-1' },
  review_request: { 1: 'Cyrus', 2: 'https://g.page/r/review' },
};

const NAMES = ['checkin_info', 'welcome', 'activity_notice', 'checkout_reminder', 'review_request'];

async function submit(name) {
  const body = TEMPLATES.find((t) => t.name === name).body;
  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: `airco_${name}_${Date.now().toString(36)}`,
      language: 'en',
      variables: EXAMPLES[name],
      types: { 'twilio/text': { body } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) return { name, error: `create failed: ${created.message ?? createRes.status}` };
  const subRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${name}_v${Date.now().toString(36)}`, category: 'UTILITY' }),
    signal: AbortSignal.timeout(15000),
  });
  const sub = await subRes.json().catch(() => ({}));
  if (!subRes.ok) return { name, sid: created.sid, error: `submit failed: ${sub.message ?? subRes.status}` };
  return { name, sid: created.sid, status: sub.whatsapp?.status ?? 'received' };
}

async function approvalStatus(sid) {
  const r = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, {
    headers: { Authorization: auth },
  });
  if (!r.ok) return 'unknown';
  const j = await r.json().catch(() => ({}));
  return j.whatsapp?.status ?? 'unknown';
}

const mode = process.argv[2] ?? '';

if (mode === '--swap') {
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  for (const p of pending) {
    if (!p.sid || p.done) continue;
    const st = await approvalStatus(p.sid);
    console.log(`${p.name}: ${st}`);
    if (st === 'approved') {
      const body = TEMPLATES.find((t) => t.name === p.name).body;
      await setTemplateBody(p.name, body);
      await setTemplateContentSid(p.name, p.sid);
      console.log(`  → SWAPPED body + ContentSid (${p.sid})`);
      p.done = true;
    }
  }
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 1));
  process.exit(0);
}

const results = [];
for (const name of NAMES) {
  const r = await submit(name);
  console.log(JSON.stringify(r));
  results.push(r);
}
fs.writeFileSync(PENDING_FILE, JSON.stringify(results, null, 1));
console.log('pending map saved');
process.exit(0);
