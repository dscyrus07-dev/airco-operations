// FIX 6 tests: migrations run before the server starts, fail loudly.
// Uses the local docker-compose postgres; skips when unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const FRESH_DB = 'postgres://postgres:postgres@127.0.0.1:5432/airco_test_fresh';
const MIGRATE = decodeURIComponent(new URL('../scripts/migrate.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function run(node, args, env) {
  return new Promise((resolve) => {
    execFile(node, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

test('FIX 6 #1: pending migrations apply on a fresh database (deploy simulation)', async (t) => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    return t.skip(`test DB unavailable (${err.code ?? err.message})`);
  }
  try {
    await admin.query('DROP DATABASE IF EXISTS airco_test_fresh');
    await admin.query('CREATE DATABASE airco_test_fresh');
    const r = await run(process.execPath, [MIGRATE], { DATABASE_URL: FRESH_DB });
    assert.equal(r.code, 0, `migrate failed: ${r.stderr}`);
    assert.match(r.stdout, /migrations complete/);
    const probe = new pg.Pool({ connectionString: FRESH_DB });
    const tables = (await probe.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('guests','messages','bookings','import_batches','schema_migrations')`
    )).rows.map((x) => x.table_name).sort();
    await probe.end();
    assert.deepEqual(tables, ['bookings', 'guests', 'import_batches', 'messages', 'schema_migrations']);
    // re-run must be a no-op (idempotent deploy)
    const r2 = await run(process.execPath, [MIGRATE], { DATABASE_URL: FRESH_DB });
    assert.equal(r2.code, 0);
    assert.ok(!/applied /.test(r2.stdout), 'second run should apply nothing');
  } finally {
    await admin.query('DROP DATABASE IF EXISTS airco_test_fresh').catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('FIX 6 #2: failing migration exits non-zero — server must not boot past it', async (t) => {
  const r = await run(process.execPath, [MIGRATE], {
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9999/nope',
  });
  assert.notEqual(r.code, 0, 'migrate must exit non-zero on failure');
  // package.json start chains with && — non-zero migrate prevents server boot
  const pkg = (await import('../package.json', { with: { type: 'json' } })).default;
  assert.match(pkg.scripts.start, /^node scripts\/migrate\.js && node server\.js$/);
});
