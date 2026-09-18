// Grants WhatsApp opt-in to a test guest (TEST-ONLY convenience).
// Usage: node scripts/optin-guest.js <phone-digits>
import 'dotenv/config';
import pg from 'pg';

const phone = String(process.argv[2] ?? '').replace(/\D/g, '');
if (!phone) {
  console.error('usage: node scripts/optin-guest.js <phone-digits>');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const r = await client.query(
  'UPDATE guests SET whatsapp_opt_in = TRUE WHERE phone = $1 RETURNING id, name',
  [phone]
);
console.log(r.rows.length ? `opted in: guest ${r.rows[0].id} (${r.rows[0].name})` : `no guest ${phone}`);
await client.end();
