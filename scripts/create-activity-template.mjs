// One-shot: create the activity_notice Twilio Content + submit for WhatsApp
// approval + store the ContentSid in template_settings.
import 'dotenv/config';
import pg from 'pg';

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

const BODY =
  '👀 Happening at Zostel Mumbai!\n\n' +
  '{{1}}\n' +
  '📅 {{2}}\n' +
  '🕘 {{3}}\n' +
  '📍 {{4}}\n\n' +
  'Come meet the hostel gang — see you there ✌️';

const EXAMPLES = { 1: 'DJ NIGHT', 2: 'Monday, 28 Sept', 3: '9 pm', 4: 'Cafe Zone' };

const create = await fetch('https://content.twilio.com/v1/Content', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    friendly_name: `airco_activity_notice_${Date.now().toString(36)}`,
    language: 'en',
    variables: EXAMPLES,
    types: { 'twilio/text': { body: BODY } },
  }),
});
const created = await create.json().catch(() => ({}));
if (!create.ok) {
  console.log('CREATE FAILED:', JSON.stringify(created).slice(0, 300));
  process.exit(1);
}
console.log('created:', created.sid);

const submit = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `airco_activity_notice_${Date.now().toString(36)}`, category: 'UTILITY' }),
});
const submitted = await submit.json().catch(() => ({}));
console.log('submit status:', submit.status, '| approval:', JSON.stringify(submit.whatsapp?.status ?? submit.status));

// store in template_settings (body + content_sid) — the send path reads it
const pgMod = await import('pg');
const pool = new pgMod.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query(
  `INSERT INTO template_settings (name, body, content_sid, updated_at)
   VALUES ('activity_notice', $1, $2, now())
   ON CONFLICT (name) DO UPDATE SET body = $1, content_sid = $2, updated_at = now()`,
  [BODY, created.sid]
);
await pool.end();
console.log('stored in template_settings: activity_notice →', created.sid);
process.exit(0);
