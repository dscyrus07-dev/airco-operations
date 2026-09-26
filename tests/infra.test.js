// FIX 12 (M2) + FIX 13 (M1) tests: DB SSL verification, rate-limiter eviction.
import test from 'node:test';
import assert from 'node:assert/strict';

// NOTE: resolveSsl reads process.env.DATABASE_URL — tests pass URLs explicitly.
const { resolveSsl } = await import('../src/db.js');
const { rateLimit, hitsSize } = await import('../src/rate-limit.js');

test('FIX 12 #1: Supabase URL → verified SSL with the bundled CA', () => {
  const cfg = resolveSsl('postgres://postgres:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
  assert.equal(cfg.ssl.rejectUnauthorized, true);
  assert.match(cfg.ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(cfg.ssl.servername, 'aws-0-ap-south-1.pooler.supabase.com');
});

test('FIX 12 #2: localhost → no SSL config (local docker)', () => {
  const cfg = resolveSsl('postgres://postgres:postgres@127.0.0.1:5432/airco_test');
  assert.deepEqual(cfg, {});
});

test('FIX 12 #3: non-Supabase cloud host without CA → relaxed mode preserved', () => {
  const cfg = resolveSsl('postgres://u:p@ep-cool-name.eu-central-1.aws.neon.tech:5432/db');
  assert.equal(cfg.ssl.rejectUnauthorized, false);
  assert.equal(cfg.ssl.ca, undefined);
});

test('FIX 12 #4: DATABASE_SSL_CA_PATH override wins', () => {
  process.env.DATABASE_SSL_CA_PATH = decodeURIComponent(
    new URL('../certs/prod-ca-2021.crt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  );
  try {
    const cfg = resolveSsl('postgres://u:p@neon.tech/db');
    assert.equal(cfg.ssl.rejectUnauthorized, true);
    assert.match(cfg.ssl.ca, /BEGIN CERTIFICATE/);
  } finally {
    delete process.env.DATABASE_SSL_CA_PATH;
  }
});

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}
const fakeReq = (ip) => ({ ip });

test('FIX 13 #1: requests beyond max are rate-limited', () => {
  const mw = rateLimit({ max: 2, windowMs: 60_000 });
  const req = fakeReq('1.2.3.4');
  assert.equal(mw(req, fakeRes(), () => 'next'), 'next');
  const passRes = fakeRes();
  mw(req, passRes, () => {});
  assert.equal(passRes.statusCode, 0, 'second request within max passes');
  const res = fakeRes();
  mw(req, res, () => {});
  assert.equal(res.statusCode, 429);
});

test('FIX 13 #2: stale entries are evicted after the window', async () => {
  const mw = rateLimit({ max: 100, windowMs: 50 });
  mw(fakeReq('5.6.7.8'), fakeRes(), () => {});
  assert.ok(hitsSize() >= 1);
  await new Promise((r) => setTimeout(r, 120)); // > windowMs; sweeper runs every 50ms
  assert.equal(hitsSize(), 0, 'stale entries must be evicted');
});
