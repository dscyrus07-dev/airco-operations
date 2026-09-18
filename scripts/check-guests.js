// Shows all guests with consent + journey state. Usage: node scripts/check-guests.js
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const rows = await client.query(
  `SELECT id, phone, name, journey_state, whatsapp_opt_in, activities_opt_out, ai_paused,
          to_char(check_in,'YYYY-MM-DD') AS check_in, to_char(check_out,'YYYY-MM-DD') AS check_out
   FROM guests ORDER BY id`
);
console.table(rows.rows);
await client.end();
