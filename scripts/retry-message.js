// Resets a failed message back to queued so the dispatcher retries it.
// Usage: node scripts/retry-message.js <messageId>
import 'dotenv/config';
import pg from 'pg';

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) {
  console.error('usage: node scripts/retry-message.js <message-id>');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const r = await client.query(
  `UPDATE messages SET status = 'queued', retry_count = 0
   WHERE id = $1 AND status = 'failed'
   RETURNING id, status, template_name`,
  [id]
);
console.log(r.rows.length ? `reset message ${id} -> queued` : `message ${id} not found or not failed`);
await client.end();
