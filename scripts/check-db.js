// Verifies the database connection and schema (works for local or Supabase).
// Usage: node scripts/check-db.js
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});
await client.connect();
const tables = await client.query(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"
);
console.log('tables:', tables.rows.map((r) => r.tablename).join(', '));
for (const name of ['guests', 'messages', 'templates', 'requests', 'activities', 'journey_events']) {
  const r = await client.query(`SELECT count(*)::int AS n FROM ${name}`);
  console.log(`  ${name}: ${r.rows[0].n} rows`);
}
await client.end();
