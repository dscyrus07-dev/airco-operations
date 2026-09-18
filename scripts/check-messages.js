// Full detail for recent outbound messages. Usage: node scripts/check-messages.js [limit]
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const limit = Number(process.argv[2] ?? 10);
const rows = await client.query(
  `SELECT id, message_type, template_name, status, left(coalesce(last_error,''), 100) AS err,
          left(coalesce(content,''), 60) AS content, trigger_reason, created_at
   FROM messages ORDER BY id DESC LIMIT $1`,
  [limit]
);
for (const r of rows.rows) {
  console.log(`#${r.id} [${r.message_type}] ${r.status} | tpl=${r.template_name} | ${r.trigger_reason} | ${r.created_at.toISOString()}`);
  if (r.err) console.log(`   err: ${r.err}`);
  if (r.content) console.log(`   content: ${r.content.replace(/\n/g, ' | ')}`);
}
await client.end();
