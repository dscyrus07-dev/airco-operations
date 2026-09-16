import 'dotenv/config';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const SECRET = process.env.BOOKING_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('BOOKING_WEBHOOK_SECRET not set in .env');
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  args[rest[i].replace(/^--/, '')] = rest[i + 1];
}

function usage() {
  console.log(`usage:
  node scripts/simulate.js booking --phone 919876543210 --name "Rahul" --check-in 2026-09-16 --check-out 2026-09-19 [--room 304]
  node scripts/simulate.js checkin --phone 919876543210
  node scripts/simulate.js checkout --phone 919876543210`);
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  console.log(res.status, JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
}

const phone = args.phone;
if (!phone) usage();

if (cmd === 'booking') {
  await post('/webhooks/booking', {
    phone,
    name: args.name || 'Test Guest',
    room: args.room || null,
    check_in: args['check-in'],
    check_out: args['check-out'],
  });
} else if (cmd === 'checkin') {
  await post('/webhooks/checkin', { phone });
} else if (cmd === 'checkout') {
  await post('/webhooks/checkout', { phone });
} else {
  usage();
}
