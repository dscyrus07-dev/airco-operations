// Simulates a signed inbound WhatsApp webhook locally (as Meta would deliver
// it) — for testing guest replies without needing a phone.
// Usage: node scripts/simulate-inbound.js --phone 918855994761 --text "STOP"
import 'dotenv/config';
import crypto from 'node:crypto';

const base = process.env.BASE_URL || 'http://localhost:3100';
const appSecret = process.env.WHATSAPP_APP_SECRET;
if (!appSecret) {
  console.error('WHATSAPP_APP_SECRET not set');
  process.exit(1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const phone = args.phone;
const text = args.text;
if (!phone || !text) {
  console.error('usage: node scripts/simulate-inbound.js --phone <digits> --text "message"');
  process.exit(1);
}

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'local-sim',
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ profile: { name: 'Sim Guest' }, wa_id: phone }],
            messages: [
              {
                from: phone,
                id: `wamid.localsim.${Date.now()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: text },
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

const res = await fetch(`${base}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body,
});
console.log('webhook status:', res.status, '— inbound', JSON.stringify(text), 'from', phone);
if (res.status !== 200) process.exit(1);
