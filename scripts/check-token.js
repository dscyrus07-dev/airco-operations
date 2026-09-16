import 'dotenv/config';

const token = process.env.WHATSAPP_ACCESS_TOKEN;
if (!token || token === 'PLACEHOLDER_SET_ME') {
  console.error('WHATSAPP_ACCESS_TOKEN not set to a real token');
  process.exit(1);
}

async function fetchWithRetry(url, options, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`network attempt ${i} failed (${err.cause?.code ?? err.message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const res = await fetchWithRetry(
  `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error('debug_token failed:', res.status, JSON.stringify(body));
  process.exit(1);
}
const d = body.data ?? {};
console.log('token valid:', d.is_valid);
console.log('app_id:', d.app_id);
console.log('type:', d.type);
console.log(
  'expires_at:',
  d.expires_at === 0
    ? 'never (permanent/System User token — good)'
    : `${new Date(d.expires_at * 1000).toISOString()} (temporary token — replace with a System User token)`
);
console.log('scopes:', (d.scopes ?? []).join(', ') || '(none)');
if (d.is_valid === false) process.exit(1);

const pnRes = await fetchWithRetry(
  `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const pn = await pnRes.json().catch(() => ({}));
if (!pnRes.ok) {
  console.error('phone number lookup failed:', pnRes.status, JSON.stringify(pn));
  process.exit(1);
}
console.log('business number:', pn.display_phone_number, `("${pn.verified_name}")`);
console.log('quality rating:', pn.quality_rating ?? 'n/a');
