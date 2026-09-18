// Inspect a message row fully. Usage: node scripts/inspect-message.js <id>
import 'dotenv/config';
import pg from 'pg';

const id = Number(process.argv[2]);
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const r = await client.query('SELECT * FROM messages WHERE id = $1', [id]);
console.log(JSON.stringify(r.rows[0], null, 1));
await client.end();
