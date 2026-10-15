// Cross-verifies the 5 journey templates against Twilio's Content API docs:
// structure, variables-as-examples, approval submission state, naming rules.
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = 'Basic ' + Buffer.from(`${SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

const EXPECTED = [
  { name: 'booking_confirmation', vars: 4 },
  { name: 'checkin_info', vars: 1 },
  { name: 'welcome', vars: 1 },
  { name: 'checkout_reminder', vars: 1 },
  { name: 'review_request', vars: 2 },
];

// Morjim rebrand templates (created 14 Oct 2026, pending Meta approval at submit time)
const NEW_SIDS = {
  booking_confirmation: 'HX1338185d978acb508f3fd297c6b896a3',
  checkin_info: 'HXbd22fc0c95d26213e604f02f713d25a9',
  welcome: 'HX4a07baaacb520ed0d0b34c3ba193f4d9',
  checkout_reminder: 'HXba30114e10672f1540a52c5e0b58ed80',
  review_request: 'HX88fcc2f7b6ede032dc108d2434a84e91',
};

async function get(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    return res.json().catch(() => ({}));
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return get(url, attempt + 1);
  }
}

let issues = 0;
for (const [name, sid] of Object.entries(NEW_SIDS)) {
  const c = await get(`https://content.twilio.com/v1/Content/${sid}`);
  const ar = await get(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`);
  const w = ar.whatsapp ?? {};
  const text = c.types?.['twilio/text'];
  const varCount = Object.keys(c.variables ?? {}).length;
  const placeholders = (text?.body?.match(/\{\{\d+\}\}/g) ?? []).length;
  const examplesAreValues = Object.values(c.variables ?? {}).every((v) => !/^\{\{/.test(String(v)));

  console.log(`\n== ${name} (${sid.slice(0, 12)}…) ==`);
  console.log(`  friendly_name : ${c.friendly_name}`);
  console.log(`  language      : ${c.language}`);
  console.log(`  variables     : ${JSON.stringify(c.variables)}`);
  console.log(`  body vars     : ${placeholders} placeholders / ${varCount} example values`);
  console.log(`  approval      : ${w.status} | name="${w.name}" | category=${w.category}`);

  // checks against Twilio docs + Meta rules
  if (c.language !== 'en') { console.log('  ❌ language should be "en"'); issues++; }
  if (!examplesAreValues) { console.log('  ✗ variables are placeholders, not example values'); issues++; }
  if (placeholders !== EXPECTED.find((e) => e.name === name)?.vars) { console.log('  ✗ placeholder count mismatch'); issues++; }
  if (varCount !== placeholders) { console.log('  ✗ example count != placeholder count'); issues++; }
  if (!/^[a-z0-9_]+$/.test(w.name ?? '')) { console.log('  ✗ template name has invalid chars (Meta: lowercase alnum + _)'); issues++; }
  if (w.name !== name) { console.log('  ✗ approval name mismatch'); issues++; }
  if (w.category !== 'UTILITY') { console.log('  ✗ category is not UTILITY'); issues++; }
  if (!['received', 'pending', 'approved'].includes(w.status)) { console.log('  ✗ unexpected approval status'); issues++; }
  if (w.status === 'pending') console.log('  ✓ properly submitted to Meta (pending review)');
  if (!text?.body) { console.log('  ✗ missing twilio/text body'); issues++; }
}

console.log(`\n=== ${issues === 0 ? 'ALL CHECKS PASSED' : issues + ' ISSUE(S) FOUND'} ===`);
