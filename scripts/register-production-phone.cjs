// Production phone registration helper for the Zostel WABA (SMB).
// Meta requires SMS/voice verification + PIN for Cloud API registration.
//
// Usage:
//   node scripts/register-production-phone.cjs request sms     — send SMS code to the phone
//   node scripts/register-production-phone.cjs request voice   — send voice code
//   node scripts/register-production-phone.cjs verify <code>   — verify the received code
//   node scripts/register-production-phone.cjs register <pin>  — register with 6-digit PIN
//   node scripts/register-production-phone.cjs status          — check current status
require('dotenv').config();

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PID = '1380467685139092'; // +91 88797 31627 production phone number ID
const API = 'https://graph.facebook.com/v19.0';

async function call(path, method, body) {
  const res = await fetch(`${API}/${PID}/${path}`, {
    method: method || 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

const [cmd, arg] = process.argv.slice(2);

(async () => {
  if (cmd === 'status') {
    const r = await call('?fields=display_phone_number,status,code_verification_status,platform_type,quality_rating');
    console.log(JSON.stringify(r.body, null, 2));
  } else if (cmd === 'request') {
    const method = process.argv[3] || 'sms';
    const r = await call('request_code', 'POST', { code_method: method.toUpperCase(), language: 'en' });
    console.log(JSON.stringify(r.body, null, 2));
    if (r.status === 200) console.log(`\n>>> Code sent via ${method}. Check the phone, then run: node scripts/register-production-phone.cjs verify <code>`);
  } else if (cmd === 'verify') {
    const code = process.argv[3];
    if (!code) { console.error('usage: verify <code>'); process.exit(1); }
    const r = await call('verify_code', 'POST', { code: String(code) });
    console.log(JSON.stringify(r.body, null, 2));
    if (r.status === 200) console.log('\n>>> Phone verified! Now run: node scripts/register-production-phone.cjs register <6-digit-pin>');
  } else if (cmd === 'register') {
    const pin = process.argv[3];
    if (!pin || !/^\d{6}$/.test(pin)) { console.error('usage: register <6-digit-pin>'); process.exit(1); }
    const r = await call('register', 'POST', { messaging_product: 'whatsapp', pin });
    console.log(JSON.stringify(r.body, null, 2));
    if (r.status === 200) console.log('\n>>> REGISTERED! The phone is now live on Cloud API.');
  } else {
    console.log('Usage:');
    console.log('  node scripts/register-production-phone.cjs status');
    console.log('  node scripts/register-production-phone.cjs request sms|voice');
    console.log('  node scripts/register-production-phone.cjs verify <code>');
    console.log('  node scripts/register-production-phone.cjs register <pin>');
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
