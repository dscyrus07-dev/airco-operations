// One-shot: update the WhatsApp sender display name (with a profile field so the body isn't empty).
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const SENDER_SID = 'XE83fb3c95611185e7ac64146e3835b2e6'; // whatsapp:+918356922317

const res = await fetch(`https://messaging.twilio.com/v2/Channels/Senders/${SENDER_SID}`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    profile: {
      name: 'Zostel Morjim',
      about: 'Your beachside backpacker base in Morjim, Goa for stays, stories, new friends & adventures. 🎒🌴',
    },
  }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log('NAME UPDATE FAILED:', res.status, JSON.stringify(out).slice(0, 400));
  process.exit(1);
}
console.log('display name update submitted ✓');
console.log('  name:', out.profile?.name);
console.log('  status:', out.status);
process.exit(0);
