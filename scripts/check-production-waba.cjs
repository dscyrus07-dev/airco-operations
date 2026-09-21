// Checks the production WABA status and lists its phone numbers + templates.
// Usage: node scripts/check-production-waba.js
require('dotenv').config();

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const API = 'https://graph.facebook.com/v19.0';

async function get(path) {
  const r = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  // Production WABA from the brief
  const PROD_WABA = '2035908973733316';
  console.log('=== Production WABA', PROD_WABA, '===');
  const waba = await get(`${PROD_WABA}?fields=name,account_review_status,business_verification_status,onboarding_status`);
  console.log(JSON.stringify(waba, null, 2));

  console.log('\n=== Phone numbers on production WABA ===');
  try {
    const phones = await get(`${PROD_WABA}/phone_numbers?fields=display_phone_number,verified,name,status,quality_rating`);
    for (const p of phones.data || []) console.log(JSON.stringify(p));
  } catch (e) { console.log('phone list error:', e.message); }

  console.log('\n=== Message templates on production WABA ===');
  try {
    const tpls = await get(`${PROD_WABA}/message_templates?fields=name,status,language,category`);
    for (const t of tpls.data || []) console.log(`${t.name} [${t.language}] ${t.category} -> ${t.status}`);
  } catch (e) { console.log('template list error:', e.message); }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
