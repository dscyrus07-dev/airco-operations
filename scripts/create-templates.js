// Creates the Phase 1 templates in Meta via the Graph API, from the same
// definitions the send path uses (src/templates/definitions.js).
// Usage: node scripts/create-templates.js [--status-only]
import 'dotenv/config';
import { TEMPLATES } from '../src/templates/definitions.js';

const API = 'https://graph.facebook.com/v21.0';
const token = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = process.env.WHATSAPP_WABA_ID;

if (!token || !wabaId) {
  console.error('missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_WABA_ID in .env');
  process.exit(1);
}

async function call(path, init) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      const code = err.cause?.code ?? err.message;
      console.warn(`  network attempt ${attempt} failed: ${code}`);
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function createOne(t) {
  const res = await call(`/${wabaId}/message_templates`, {
    method: 'POST',
    body: JSON.stringify({
      name: t.name,
      language: 'en',
      category: t.category.toUpperCase(),
      components: [{ type: 'BODY', text: t.body }],
    }),
  });
  if (res.status === 200) {
    console.log(`  ${t.name}: CREATED (id ${res.body.id})`);
    return;
  }
  const msg = res.body?.error?.message ?? JSON.stringify(res.body).slice(0, 200);
  if (/already exists/i.test(msg)) {
    console.log(`  ${t.name}: EXISTS (skipped)`);
    return;
  }
  console.log(`  ${t.name}: ERROR ${res.status} — ${msg}`);
}

async function statusOnly() {
  const names = new Set(TEMPLATES.map((t) => t.name));
  const res = await call(`/${wabaId}/message_templates?limit=100`, {});
  if (res.status !== 200) {
    console.error('list failed:', res.status, res.body?.error?.message);
    process.exit(1);
  }
  for (const t of res.body.data.filter((t) => names.has(t.name))) {
    console.log(
      `  ${t.name}: ${t.status} (${t.category}, ${t.language})` +
        (t.status === 'REJECTED' ? ` — reason: ${t.rejected_reason}` : '')
    );
  }
}

if (process.argv.includes('--status-only')) {
  await statusOnly();
} else {
  console.log(`Creating ${TEMPLATES.length} templates in WABA ${wabaId}...`);
  for (const t of TEMPLATES) await createOne(t);
  console.log('\nStatus:');
  await statusOnly();
}
