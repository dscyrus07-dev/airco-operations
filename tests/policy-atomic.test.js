// FIX 9 (M5) tests: the daily cap is enforced atomically at queue time.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';

const { withDb, cleanTables, insertGuest } = await import('./db-helper.js');
const { queueProactiveCapped } = await import('../src/messaging/outbound.js');

const COUNT_SQL = `SELECT count(*)::int AS n FROM messages
  WHERE guest_id = $1 AND direction = 'out' AND message_type = 'template'
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
        = (now() AT TIME ZONE 'Asia/Kolkata')::date`;

const payload = (guestId, tag) => ({
  guestId,
  content: `proactive ${tag}`,
  messageType: 'template',
  templateName: null,
  templateComponents: [],
  triggerReason: `test:${tag}`,
});

test('FIX 9 #1: two concurrent queue attempts at cap-1 → exactly one succeeds', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919500000001', name: 'CapRace' });
    // one template message already sent today; cap = 2 → one slot left
    await pool.query(
      `INSERT INTO messages (guest_id, direction, message_type, status, trigger_reason)
       VALUES ($1, 'out', 'template', 'sent', 'test:seed')`,
      [g.id]
    );
    const attempts = await Promise.all([
      queueProactiveCapped(payload(g.id, 'a'), 2, COUNT_SQL, [g.id]),
      queueProactiveCapped(payload(g.id, 'b'), 2, COUNT_SQL, [g.id]),
    ]);
    const succeeded = attempts.filter((r) => r !== null);
    assert.equal(succeeded.length, 1, 'exactly one of two concurrent attempts wins');
    const total = (await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE guest_id = $1 AND direction='out' AND message_type='template'`,
      [g.id]
    )).rows[0].n;
    assert.equal(total, 2, 'cap respected: seed + exactly one new message');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 9 #2: at cap, queue returns null (suppressed) and inserts nothing', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919500000002', name: 'AtCap' });
    await pool.query(
      `INSERT INTO messages (guest_id, direction, message_type, status, trigger_reason)
       VALUES ($1, 'out', 'template', 'sent', 'test:s1')`,
      [g.id]
    );
    await pool.query(
      `INSERT INTO messages (guest_id, direction, message_type, status, trigger_reason)
       VALUES ($1, 'out', 'template', 'sent', 'test:s2')`,
      [g.id]
    );
    const res = await queueProactiveCapped(payload(g.id, 'x'), 2, COUNT_SQL, [g.id]);
    assert.equal(res, null);
    const total = (await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE guest_id = $1`,
      [g.id]
    )).rows[0].n;
    assert.equal(total, 2);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 9 #3: concurrent sends for DIFFERENT guests do not block each other', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g1 = await insertGuest(pool, { phone: '919500000003', name: 'G3' });
    const g4 = await insertGuest(pool, { phone: '919500000004', name: 'G4' });
    const [a, b] = await Promise.all([
      queueProactiveCapped(payload(g4.id, 'g4'), 2, COUNT_SQL, [g4.id]),
      queueProactiveCapped(payload(g1.id, 'g1'), 2, COUNT_SQL, [g1.id]),
    ]);
    assert.ok(a !== null && b !== null, 'both different-guest sends succeed');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
