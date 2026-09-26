import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pool = null;

// FIX 12 (M2): verify the server certificate against Supabase's CA instead of
// disabling validation. The CA is the canonical prod-ca-2021.crt published in
// Supabase's own CLI repo and was VERIFIED against the live server (TLS
// handshake succeeds with rejectUnauthorized: true). Override with
// DATABASE_SSL_CA (inline PEM) or DATABASE_SSL_CA_PATH. Non-Supabase cloud
// hosts keep the legacy relaxed mode unless a CA is supplied.
export function resolveSsl(databaseUrl = process.env.DATABASE_URL ?? '') {
  const isCloud = /supabase|neon\.tech|amazonaws|render\.com|railway/i.test(databaseUrl);
  if (!isCloud) return {};
  let ca = process.env.DATABASE_SSL_CA;
  if (!ca && process.env.DATABASE_SSL_CA_PATH) {
    try { ca = fs.readFileSync(process.env.DATABASE_SSL_CA_PATH, 'utf8'); } catch { /* fall through */ }
  }
  if (!ca && /supabase/i.test(databaseUrl)) {
    try {
      ca = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'prod-ca-2021.crt'),
        'utf8'
      );
    } catch { /* bundled CA missing — relaxed mode */ }
  }
  if (ca) {
    let hostname = '';
    try { hostname = new URL(databaseUrl).hostname; } catch { /* unparseable */ }
    return { ssl: { ca, rejectUnauthorized: true, ...(hostname ? { servername: hostname } : {}) } };
  }
  return { ssl: { rejectUnauthorized: false } };
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ...resolveSsl(),
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
