// FIX 3 (H2) + FIX 4 (H3) tests: dispatch claim, reconciliation, scheduled retries.
// DB-backed — skips when the test database (docker compose) is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';

const { withDb, cleanTables, insertGuest } = await import('./db-helper.js');
const { dispatchPending, queueMessage } = await import('../src/messaging/outbound.js');

// Dry-run Twilio creds: sends "succeed" without network.
const DRY_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  TWILIO_ACCOUNT_SID: 'ACtesttesttesttesttesttesttesttest',
  TWILIO_AUTH_TOKEN: 'dryrun-token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+91000000000',
};

function setEnv(env) {
  for (const k of ['WHATSAPP_DRY_RUN', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM']) {
    if (env?.[k]) process.env[k] = env[k];
    else delete process.env[k];
  }
}

async function insertQueued(pool, guestId, content = 'test') {
  const { rows } = await pool.query(
    `INSERT INTO messages (guest_id, direction, content, message_type, status, trigger_reason)
     VALUES ($1, 'out', $2, 'free_text', 'queued', 'test') RETURNING *`,
    [guestId, content]
  );
  return rows[0];
}

test('FIX 3 #1: crashed dispatch (stuck sending, no SID) → failed for review, healthy message still sent', async (t) => {
  setEnv(DRY_ENV);
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000001', name: 'A' });
    const stuck = await insertQueued(pool, g.id, 'stuck');
    await pool.query(
      `UPDATE messages SET status = 'sending', claimed_at = now() - interval '10 minutes' WHERE id = $1`,
      [stuck.id]
    );
    const healthy = await insertQueued(pool, g.id, 'healthy');
    await dispatchPending();
    const after = (await pool.query('SELECT id, status, last_error FROM messages ORDER BY id')).rows;
    const stuckRow = after.find((m) => m.id === stuck.id);
    const healthyRow = after.find((m) => m.id === healthy.id);
    assert.equal(stuckRow.status, 'failed');
    assert.match(stuckRow.last_error, /manual review/);
    assert.equal(healthyRow.status, 'sent'); // not blocked by the stuck one
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 3 #2: a freshly-claimed message is never re-picked by dispatch (no double send)', async (t) => {
  setEnv(DRY_ENV);
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000002', name: 'B' });
    const m = await insertQueued(pool, g.id, 'claimed');
    await pool.query(`UPDATE messages SET status = 'sending', claimed_at = now() WHERE id = $1`, [m.id]);
    await dispatchPending();
    const row = (await pool.query('SELECT status FROM messages WHERE id = $1', [m.id])).rows[0];
    assert.equal(row.status, 'sending'); // untouched — claim gate held
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 3 #3: stuck sending WITH a SID is deferred for Twilio reconciliation — never blind-resent', async (t) => {
  setEnv(DRY_ENV); // fetchMessageStatus returns null in dry-run → deferred
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000003', name: 'C' });
    const m = await insertQueued(pool, g.id, 'withsid');
    await pool.query(
      `UPDATE messages SET status = 'sending', claimed_at = now() - interval '10 minutes',
         wa_message_id = 'SMfakefakefakefakefakefakefakefake' WHERE id = $1`,
      [m.id]
    );
    await dispatchPending();
    const row = (await pool.query('SELECT status, wa_message_id FROM messages WHERE id = $1', [m.id])).rows[0];
    assert.equal(row.status, 'sending'); // deferred, NOT resent, NOT failed
    assert.equal(row.wa_message_id, 'SMfakefakefakefakefakefakefakefake');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 4 #1: failing sends are scheduled with backoff — batch finishes fast (no inline sleeps)', async (t) => {
  setEnv(null); // no Twilio config → every send throws a retryable error
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000004', name: 'D' });
    const a = await insertQueued(pool, g.id, 'fail-a');
    const b = await insertQueued(pool, g.id, 'fail-b');
    const t0 = Date.now();
    await dispatchPending();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `dispatch took ${elapsed}ms — inline retries are back`);
    const rows = (await pool.query('SELECT id, status, retry_count, next_attempt_at, last_error FROM messages ORDER BY id')).rows;
    for (const row of rows) {
      assert.equal(row.status, 'queued'); // rescheduled, not lost
      assert.equal(row.retry_count, 1);
      assert.ok(row.next_attempt_at > new Date(), 'retry scheduled in the future');
      assert.ok(row.last_error.length > 0);
    }
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 4 #2: retry ceiling preserved — attempt beyond MAX_ATTEMPTS fails permanently', async (t) => {
  setEnv(null);
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000005', name: 'E' });
    const m = await insertQueued(pool, g.id, 'exhausted');
    await pool.query(`UPDATE messages SET retry_count = 4 WHERE id = $1`, [m.id]);
    await dispatchPending();
    const row = (await pool.query('SELECT status, retry_count FROM messages WHERE id = $1', [m.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 5);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 4 #3: next_attempt_at gating — future message skipped, others dispatched', async (t) => {
  setEnv(DRY_ENV);
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919200000006', name: 'F' });
    const later = await insertQueued(pool, g.id, 'later');
    const nowMsg = await insertQueued(pool, g.id, 'now');
    await pool.query(
      `UPDATE messages SET next_attempt_at = now() + interval '10 minutes' WHERE id = $1`,
      [later.id]
    );
    await dispatchPending();
    const rows = (await pool.query('SELECT id, status FROM messages ORDER BY id')).rows;
    assert.equal(rows.find((m) => m.id === nowMsg.id).status, 'sent');
    assert.equal(rows.find((m) => m.id === later.id).status, 'queued'); // gated, untouched
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
