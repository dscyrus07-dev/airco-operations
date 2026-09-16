import pg from 'pg';

let pool = null;

// Cloud Postgres (Supabase/Neon/etc.) requires TLS; local Docker does not.
const needsSsl = /supabase|neon\.tech|amazonaws|render\.com|railway/i.test(
  process.env.DATABASE_URL ?? ''
);

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

export async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
