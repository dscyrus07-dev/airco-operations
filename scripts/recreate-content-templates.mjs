// Re-creates the 5 Zostel journey templates WITH example variable values
// (Meta requires them for approval), submits for review, and prints the
// new ContentSids. Also attempts to delete the old rejected templates.
// Usage: node scripts/recreate-content-templates.mjs
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = 'Basic ' + Buffer.from(`${SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

// Morjim rebrand run: keep the existing Mumbai templates live until the new
// ones are approved — nothing is deleted.
const OLD_SIDS = [];

const TEMPLATES = [
  {
    name: 'booking_confirmation',
    examples: { 1: 'Cyrus', 2: 'Room 203', 3: '21 Sept', 4: '23 Sept' },
    body:
      'Hey {{1}} 👋\n' +
      'Your Goa adventure is officially booked! 🎒\n' +
      '📍 Zostel Morjim, Morjim Beach\n' +
      '🛏 {{2}}\n' +
      '📅 {{3}} → {{4}}\n\n' +
      'Beach days, a buzzing cafe and a gang of travellers — all waiting for you.\n' +
      'Need anything before you arrive? Just drop it here 😎',
  },
  {
    name: 'checkin_info',
    examples: { 1: 'Cyrus' },
    body:
      'Hey {{1}}! 👋\n' +
      "Tomorrow's the day — Goa mode: ON ⚡\n\n" +
      "You're checking in at Zostel Morjim tomorrow from 1:00 PM.\n" +
      '📍 Morjim Beach, North Goa\n' +
      '🎒 Carry a valid photo ID.\n\n' +
      'Beach sunsets, shack food and a hostel full of travellers are waiting.\n' +
      'Got an arrival question? Drop it right here.',
  },
  {
    name: 'welcome',
    examples: { 1: 'Cyrus' },
    body:
      '🚨 YOU HAVE ARRIVED!\n' +
      'Welcome to Zostel Morjim, {{1}} 🧡\n\n' +
      'Your room is sorted. Your Goa story starts now.\n' +
      '🌆 Catch a Morjim Beach sunset\n' +
      '🍜 Beach shack hopping\n' +
      '🎬 Chapora Fort views\n' +
      '👋 Meet the gang in the common area\n\n' +
      'This chat is your direct line to us — need anything, just say hi.',
  },
  {
    name: 'checkout_reminder',
    examples: { 1: 'Cyrus' },
    body:
      'Hey {{1}} 👋\n' +
      'Your Goa stay is almost at its final chapter.\n\n' +
      '🕙 Check-out tomorrow by 10:00 AM.\n' +
      'Do a quick sweep for chargers, cables and that one sock hiding under the bed 😄\n\n' +
      "Need anything before you head out? We're right here.",
  },
  {
    name: 'review_request',
    examples: { 1: 'Cyrus', 2: 'https://www.zostel.com/zostel/morjim/' },
    body:
      '🧡 And just like that… your Goa chapter comes to an end.\n' +
      'Thanks for being part of the Zostel Morjim gang, {{1}}.\n\n' +
      "We hope you're leaving with a few new stories, a few new friends, and maybe a little more of Goa than you expected. 🌆\n\n" +
      'Got a minute?\n' +
      '⭐ Tell us how your stay was:\n' +
      '{{2}}\n\n' +
      'See you on the next adventure 🎒',
  },
];

async function call(url, method, body, attempt = 1) {
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j };
  } catch (err) {
    if (attempt >= 4) throw err;
    console.warn(`  network retry ${attempt}...`);
    await new Promise((r) => setTimeout(r, 2500 * attempt));
    return call(url, method, body, attempt + 1);
  }
}

// 1. try deleting the old rejected templates
console.log('Cleaning up old rejected templates...');
for (const sid of OLD_SIDS) {
  const r = await call(`https://content.twilio.com/v1/Content/${sid}`, 'DELETE');
  console.log(`  ${sid.slice(0, 12)}…: ${r.status === 204 || r.status === 200 ? 'DELETED' : 'kept (' + r.status + ')'}`);
}

// 2. create new templates WITH example values
console.log('\nCreating templates with example values...');
const created = {};
for (const t of TEMPLATES) {
  const r = await call('https://content.twilio.com/v1/Content', 'POST', {
    friendly_name: `airco_morjim_${t.name}`,
    language: 'en',
    variables: t.examples,
    types: { 'twilio/text': { body: t.body } },
  });
  if (r.status === 201) {
    created[t.name] = r.body.sid;
    console.log(`  ${t.name}: CREATED ${r.body.sid}`);
  } else {
    console.log(`  ${t.name}: ERROR ${r.status} — ${JSON.stringify(r.body).slice(0, 140)}`);
  }
}

// 3. submit for WhatsApp approval
console.log('\nSubmitting for WhatsApp approval...');
for (const [name, sid] of Object.entries(created)) {
  const r = await call(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, 'POST', {
    name,
    category: 'UTILITY',
  });
  console.log(`  ${name}: ${r.status === 201 ? 'SUBMITTED' : 'ERROR ' + r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
}

console.log('\nNew ContentSids map for TWILIO_CONTENT_SIDS:');
console.log(JSON.stringify(created, null, 1));
