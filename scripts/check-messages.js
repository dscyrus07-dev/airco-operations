// Shows recent messages with error details. Usage: node scripts/check-messages.js [limit]
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const limit = Number(process.argv[2] ?? 10);
const rows = await client.query(
  `SELECT id, direction, message_type, status, left(coalesce(last_error,''), 120) AS err,
          left(coalesce(content,''), 40) AS content, trigger_reason, created_at
   FROM messages ORDER BY id DESC LIMIT $1`,
  [limit]
);
console.table(rows.rows);
await client.end();
