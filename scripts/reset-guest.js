// Deletes a test guest and all their rows so the journey can run fresh.
// TEST-ONLY tool — bypasses the append-only audit by design.
// Usage: node scripts/reset-guest.js <phone-digits>
import 'dotenv/config';
import pg from 'pg';

const phone = String(process.argv[2] ?? '').replace(/\D/g, '');
if (!phone) {
  console.error('usage: node scripts/reset-guest.js <phone-digits>');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const found = await client.query('SELECT id, name FROM guests WHERE phone = $1', [phone]);
if (found.rows.length === 0) {
  console.log(`no guest with phone ${phone}`);
  await client.end();
  process.exit(0);
}
const guestId = found.rows[0].id;
for (const table of ['messages', 'journey_events', 'requests']) {
  const del = await client.query(`DELETE FROM ${table} WHERE guest_id = $1`, [guestId]);
  console.log(`${table}: ${del.rowCount} deleted`);
}
await client.query('DELETE FROM guests WHERE id = $1', [guestId]);
console.log(`guest ${guestId} (${found.rows[0].name}) reset — journey can run fresh`);
await client.end();
