// Creates the 5 Zostel journey Content templates in Twilio and submits them
// for WhatsApp approval.
// Usage: node scripts/create-content-templates.mjs [--list]
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const API = 'https://content.twilio.com/v1/Content';

const TEMPLATES = [
  {
    name: 'booking_confirmation',
    body:
      'Hey {{1}} 👋\n' +
      'Your Mumbai adventure is officially booked! 🎒\n' +
      '📍 Zostel Mumbai, Andheri East\n' +
      '🛏 {{2}}\n' +
      '📅 {{3}} → {{4}}\n\n' +
      'Cafe, games, a Bollywood rooftop and a gang of travellers — all waiting for you.\n' +
      'Need anything before you arrive? Just drop it here 😎',
  },
  {
    name: 'checkin_info',
    body:
      'Hey {{1}}! 👋\n' +
      "Tomorrow's the day — Mumbai mode: ON ⚡\n\n" +
      "You're checking in at Zostel Mumbai tomorrow from 1:00 PM.\n" +
      '📍 Andheri East, off Military Road, Marol\n' +
      '🎒 Carry a valid photo ID.\n\n' +
      'Rooftop views, street food and a hostel full of travellers are waiting.\n' +
      'Got an arrival question? Drop it right here.',
  },
  {
    name: 'welcome',
    body:
      '🚨 YOU HAVE ARRIVED!\n' +
      'Welcome to Zostel Mumbai, {{1}} 🧡\n\n' +
      'Your room is sorted. Your Mumbai story starts now.\n' +
      '🌆 Catch a Marine Drive sunset\n' +
      '🍜 Hunt down street food\n' +
      '🎬 Rooftop movie nights\n' +
      '👋 Meet the gang in the common area\n\n' +
      'This chat is your direct line to us — need anything, just say hi.',
  },
  {
    name: 'checkout_reminder',
    body:
      'Hey {{1}} 👋\n' +
      'Your Mumbai stay is almost at its final chapter.\n\n' +
      '🕙 Check-out tomorrow by 10:00 AM.\n' +
      'Do a quick sweep for chargers, cables and that one sock hiding under the bed 😄\n\n' +
      "Need anything before you head out? We're right here.",
  },
  {
    name: 'review_request',
    body:
      '🧡 And just like that… your Mumbai chapter comes to an end.\n' +
      'Thanks for being part of the Zostel Mumbai gang, {{1}}.\n\n' +
      "We hope you're leaving with a few new stories, a few new friends, and maybe a little more of Mumbai than you expected. 🌆\n\n" +
      'Got a minute?\n' +
      '⭐ Tell us how your stay was:\n' +
      '{{2}}\n\n' +
      'See you on the next adventure 🎒',
  },
];

const auth = {
  Authorization:
    'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
  'Content-Type': 'application/json',
};

async function call(url, method, body) {
  const res = await fetch(url, {
    method: method || 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

async function main() {
  const existing = await (await fetch('https://content.twilio.com/v1/Content?PageSize=100', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
  })).json();
  const existingByFriendly = new Set((existing.contents ?? []).map((c) => c.friendly_name));

  const created = {};
  for (const t of TEMPLATES) {
    if (existingByFriendly.has(t.name)) {
      console.log(`  ${t.name}: EXISTS (skipped)`);
      continue;
    }
    const res = await fetch('https://content.twilio.com/v1/Content', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        friendly_name: `airco_${t.name}`,
        language: 'en',
        variables: Object.fromEntries(
          [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((_, i) => [`var_${i + 1}`, `{{${i + 1}}}`])
        ),
        types: { 'twilio/text': { body: t.body } },
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  ${t.name}: CREATED ${j.sid}`);
      created[t.name] = j.sid;
    } else {
      console.log(`  ${t.name}: ERROR ${res.status} — ${JSON.stringify(j).slice(0, 150)}`);
    }
  }
  return created;
}

const created = await main();
console.log('\nSubmitting for WhatsApp approval...');
for (const [name, sid] of Object.entries(created)) {
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, category: 'UTILITY' }),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`  ${name}: approval ${res.ok ? 'SUBMITTED' : 'ERROR ' + res.status} ${JSON.stringify(j).slice(0, 120)}`);
}
