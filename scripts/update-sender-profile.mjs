// One-shot: update the WhatsApp sender business profile via Twilio Senders API v2.
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const SENDER_SID = 'XE83fb3c95611185e7ac64146e3835b2e6'; // whatsapp:+918356922317

const body = {
  profile: {
    about: 'Your beachside backpacker base in Morjim, Goa for stays, stories, new friends & adventures. 🎒🌴',
    description: 'Zostel Morjim is a lively backpacker hostel in Morjim, North Goa - steps from the beach, with a social stay, common spaces, games, a cafe and beach sunsets.',
    vertical: 'Hotel and Lodging',
    logo_url: 'https://airco-operations-production.up.railway.app/zostel-morjim-logo.jpg',
    address: 'Pushkin House, 1088/1, Near Nanu Wines, Madhlowaddo, Morjim, Pernem, North Goa, Goa, India',
    websites: [{ website: 'https://www.zostel.com', label: 'website' }],
  },
};

const res = await fetch(`https://messaging.twilio.com/v2/Channels/Senders/${SENDER_SID}`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log('UPDATE FAILED:', res.status, JSON.stringify(out).slice(0, 400));
  process.exit(1);
}
const p = out.profile ?? {};
console.log('profile updated ✓');
console.log('  name:', p.name);
console.log('  about:', (p.about ?? '').slice(0, 60));
console.log('  vertical:', p.vertical);
console.log('  address:', (p.address ?? '').slice(0, 60));
console.log('  status:', out.status);
process.exit(0);
