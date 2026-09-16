import 'dotenv/config';
import { sendText } from '../src/whatsapp/client.js';

const to = process.env.TEST_RECIPIENT_NUMBER;
if (!to) {
  console.error('TEST_RECIPIENT_NUMBER not set in .env');
  process.exit(1);
}
if (!process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN === 'PLACEHOLDER_SET_ME') {
  console.error('WHATSAPP_ACCESS_TOKEN is not set to a real token yet (see .env)');
  process.exit(1);
}

const MESSAGE = 'Airco Agent milestone test — if you can read this, the send path works.';
let lastErr;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const res = await sendText(to, MESSAGE);
    console.log('SENT ok, wa_message_id:', res.waMessageId);
    console.log('Now reply to this message and watch the webhook logs / messages table.');
    process.exit(0);
  } catch (err) {
    lastErr = err;
    if (err.status) break; // API-level rejection — retrying the same payload won't help
    console.warn(`attempt ${attempt} failed (${err.message}), retrying...`);
  }
}
console.error('SEND FAILED:', lastErr?.message ?? 'unknown error');
process.exit(1);
