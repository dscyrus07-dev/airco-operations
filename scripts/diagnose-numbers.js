import 'dotenv/config';

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const version = 'v21.0';

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

async function getJson(path) {
  const res = await fetchWithRetry(`https://graph.facebook.com/${version}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const our = await getJson(
  `/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,code_verification_status`
);
console.log('our number:', JSON.stringify(our, null, 1));

const all = await getJson(
  `/${process.env.WHATSAPP_WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`
);
console.log('all numbers in WABA:', JSON.stringify(all, null, 1));

const me = await getJson('/me');
console.log('token identity:', JSON.stringify(me, null, 1));
