// One-shot production switch: creates templates on the production WABA,
// flips .env to production phone/WABA, removes test overrides.
// Usage: node scripts/go-live.cjs
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PROD_WABA = '2035908973733316';
const PROD_PHONE_ID = '1380467685139092';
const API = 'https://graph.facebook.com/v21.0';

const TEMPLATES = [
  {
    name: 'booking_confirmation',
    category: 'UTILITY',
    body:
      'Hey {{1}} \u{1F44B}\n' +
      'Your Mumbai adventure is officially booked! \u{1F392}\n' +
      '\u{1F4CD} Zostel Mumbai, Andheri East\n' +
      '\u{1F6CF} {{2}}\n' +
      '\u{1F4C5} {{3}} \u2192 {{4}}\n\n' +
      'Cafe, games, a Bollywood rooftop and a gang of travellers \u2014 all waiting for you.\n' +
      'Need anything before you arrive? Just drop it here \u{1F60E}',
  },
  {
    name: 'checkin_info',
    category: 'UTILITY',
    body:
      'Hey {{1}}! \u{1F44B}\n' +
      "Tomorrow's the day \u2014 Mumbai mode: ON \u26A1\n\n" +
      'You\u2019re checking in at Zostel Mumbai tomorrow from 1:00 PM.\n' +
      '\u{1F4CD} Andheri East, off Military Road, Marol\n' +
      '\u{1F392} Carry a valid photo ID.\n\n' +
      'Rooftop views, street food and a hostel full of travellers are waiting.\n' +
      'Got an arrival question? Drop it right here.',
  },
  {
    name: 'welcome',
    category: 'UTILITY',
    body:
      '\u{1F6A8} YOU HAVE ARRIVED!\n' +
      'Welcome to Zostel Mumbai, {{1}} \u{1F9E1}\n\n' +
      'Your room is sorted. Your Mumbai story starts now.\n' +
      '\u{1F306} Catch a Marine Drive sunset\n' +
      '\u{1F35C} Hunt down street food\n' +
      '\u{1F3AC} Rooftop movie nights\n' +
      '\u{1F44B} Meet the gang in the common area\n\n' +
      'This chat is your direct line to us \u2014 need anything, just say hi.',
  },
  {
    name: 'checkout_reminder',
    category: 'UTILITY',
    body:
      'Hey {{1}} \u{1F44B}\n' +
      'Your Mumbai stay is almost at its final chapter.\n\n' +
      '\u{1F551} Check-out tomorrow by 10:00 AM.\n' +
      'Do a quick sweep for chargers, cables and that one sock hiding under the bed \u{1F604}\n\n' +
      'Need anything before you head out? We\u2019re right here.',
  },
  {
    name: 'review_request',
    category: 'UTILITY',
    body:
      '\u{1F9E1} And just like that\u2026 your Mumbai chapter comes to an end.\n' +
      'Thanks for being part of the Zostel Mumbai gang, {{1}}.\n\n' +
      'We hope you\u2019re leaving with a few new stories, a few new friends, and maybe a little more of Mumbai than you expected. \u{1F306}\n\n' +
      'Got a minute?\n' +
      '\u2B50 Tell us how your stay was:\n' +
      '{{2}}\n\n' +
      'See you on the next adventure \u{1F392}',
  },
];

async function call(path, init) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      console.warn(`  network attempt ${attempt} failed: ${err.message}`);
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

async function createTemplates() {
  console.log(`Creating ${TEMPLATES.length} templates on production WABA ${PROD_WABA}...`);
  for (const t of TEMPLATES) {
    const res = await call(`/${PROD_WABA}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({
        name: t.name,
        language: 'en',
        category: t.category,
        components: [{ type: 'BODY', text: t.body }],
      }),
    });
    if (res.status === 200) {
      console.log(`  ${t.name}: CREATED (id ${res.body.id})`);
    } else {
      const msg = res.body?.error?.message ?? JSON.stringify(res.body).slice(0, 150);
      if (/already exists/i.test(msg)) console.log(`  ${t.name}: EXISTS`);
      else console.log(`  ${t.name}: ERROR ${res.status} — ${msg}`);
    }
  }
}

async function listTemplates() {
  const res = await call(`/${PROD_WABA}/message_templates?limit=100`, {});
  if (res.status !== 200) {
    console.log('template list failed:', res.body?.error?.message);
    return;
  }
  const ours = res.body.data ?? [];
  if (ours.length === 0) console.log('  (no templates on production WABA)');
  for (const t of ours) {
    console.log(`  ${t.name}: ${t.status} (${t.category}, ${t.language})`);
  }
}

function flipEnv() {
  const envPath = new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  let raw = readFileSync(envPath, 'utf8');
  raw = raw.replace(/^WHATSAPP_PHONE_NUMBER_ID=.*$/m, `WHATSAPP_PHONE_NUMBER_ID=${PROD_PHONE_ID}`);
  raw = raw.replace(/^WHATSAPP_WABA_ID=.*$/m, `WHATSAPP_WABA_ID=${PROD_WABA}`);
  raw = raw.replace(/^TEMPLATE_OVERRIDES=.*$/m, '# TEMPLATE_OVERRIDES removed for production');
  writeFileSync(envPath, raw);
  console.log(`.env flipped: PHONE_NUMBER_ID=${PROD_PHONE_ID}, WABA_ID=${PROD_WABA}, TEMPLATE_OVERRIDES removed`);
}

console.log('=== PRODUCTION SWITCH ===\n');
console.log('1) Creating templates on production WABA...');
await createTemplates();
console.log('\n2) Template status:');
await listTemplates();
console.log('\n3) Flipping .env to production...');
flipEnv();
console.log('\nDone. Next: push env vars to Railway (scripts/push-env.js) and redeploy.');
