// Twilio account + sender + template status dashboard.
// Usage: node scripts/status.mjs
import 'dotenv/config';

const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = 'Basic ' + Buffer.from(`${SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

async function get(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    return res.json().catch(() => ({}));
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return get(url, attempt + 1);
  }
}

const balance = await get(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Balance.json`);
console.log(`Account ${SID.slice(0, 8)}... | balance: $${balance.balance} ${balance.currency}`);

console.log('\n--- Trust Hub (KYC) ---');
const profiles = await get('https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=10');
const plist = profiles.customer_profiles ?? [];
if (!plist.length) console.log('(no customer profiles — KYC not started)');
for (const p of plist) console.log(`${p.friendly_name} | ${p.status}`);

console.log('\n--- Content templates (WhatsApp approval) ---');
const content = await get('https://content.twilio.com/v1/Content?PageSize=100');
for (const c of content.contents ?? []) {
  const ar = await get(`https://content.twilio.com/v1/Content/${c.sid}/ApprovalRequests`);
  console.log(`${c.friendly_name.padEnd(30)} ${ar.whatsapp?.status ?? 'not submitted'}`);
}

console.log('\n--- Recent WhatsApp sends (last 5) ---');
const msgs = await get(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?PageSize=5`);
for (const m of msgs.messages ?? []) {
  console.log(`${m.sid.slice(0, 10)} | ${(m.status ?? '').padEnd(10)} | to ${m.to.slice(-10)} | ${(m.body ?? '').slice(0, 45)}`);
}
