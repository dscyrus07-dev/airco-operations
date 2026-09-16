import 'dotenv/config';
import crypto from 'node:crypto';
import { query, closePool } from '../src/db.js';

const base = process.env.BASE_URL || 'http://localhost:3100';
const appSecret = process.env.WHATSAPP_APP_SECRET;
if (!appSecret) {
  console.error('WHATSAPP_APP_SECRET not set');
  process.exit(1);
}

const phone = '919999990001';
const waMessageId = `wamid.localtest.${Date.now()}`;
const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'local-test-entry',
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ profile: { name: 'Local Webhook Test' }, wa_id: phone }],
            messages: [
              {
                from: phone,
                id: waMessageId,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Hi, this is a local webhook test reply' },
              },
            ],
          },
        },
      ],
    },
  ],
};
const body = JSON.stringify(payload);
const signature =
  'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex');

async function post() {
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body,
  });
}

const res = await post();
console.log('POST /webhook status:', res.status);
if (res.status !== 200) process.exit(1);

await new Promise((r) => setTimeout(r, 1500));

const rows = await query(
  `SELECT m.direction, m.content, m.status, g.name, g.journey_state
   FROM messages m JOIN guests g ON g.id = m.guest_id
   WHERE m.wa_message_id = $1`,
  [waMessageId]
);
console.table(rows);
if (rows.length !== 1 || rows[0].direction !== 'in' || !rows[0].content.includes('local webhook test')) {
  console.error('FAIL: signed inbound message not stored exactly once');
  process.exit(1);
}

const res2 = await post();
console.log('redelivery status:', res2.status);
await new Promise((r) => setTimeout(r, 1000));
const rows2 = await query('SELECT count(*)::int AS n FROM messages WHERE wa_message_id = $1', [
  waMessageId,
]);
if (rows2[0].n !== 1) {
  console.error('FAIL: redelivery created duplicate rows');
  process.exit(1);
}
console.log('WEBHOOK CHECK OK: signed inbound stored once, guest auto-created, redelivery idempotent');
await closePool();
