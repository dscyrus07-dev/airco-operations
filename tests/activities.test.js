// Activity broadcast tests: per-CONTENT idempotency (same content never
// re-sends; edited content re-sends to everyone) + template-based sending.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';
process.env.TWILIO_ACCOUNT_SID ??= 'ACtesttesttesttesttesttesttesttest';
process.env.TWILIO_AUTH_TOKEN ??= 'test-token';
process.env.TWILIO_WHATSAPP_FROM ??= 'whatsapp:+91000000000';
process.env.WHATSAPP_DRY_RUN = 'true'; // sends "succeed" without network

const { withDb, cleanTables, insertGuest } = await import('./db-helper.js');
const { createAndBroadcastActivity, broadcastActivityById, updateActivity } = await import('../src/agent/activities.js');

function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

test('activity re-send reaches only guests who have not received it', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    await insertGuest(pool, { phone: '919700000001', name: 'First Guest', state: 'in_stay' });
    await insertGuest(pool, { phone: '919700000002', name: 'Late Checkin', state: 'in_stay' });

    const first = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'DJ NIGHT', description: 'Cafe Zone', broadcast: true,
    });
    assert.equal(first.reached, 2, 'first send reaches both in-house guests');

    // a new guest checks in AFTER the broadcast
    await insertGuest(pool, { phone: '919700000003', name: 'Newcomer', state: 'in_stay' });

    const resend = await broadcastActivityById(first.activityId);
    assert.equal(resend.reached, 1, 're-send reaches only the new guest');
    assert.deepEqual(resend.guests, ['Newcomer']);

    const msgs = (await pool.query(
      `SELECT guest_id, count(*)::int AS n FROM messages
       WHERE trigger_reason LIKE 'activity:%' GROUP BY guest_id ORDER BY guest_id`
    )).rows;
    assert.equal(msgs.length, 3, 'three guests, one message each');
    assert.ok(msgs.every((m) => m.n === 1), 'no guest receives the same version twice');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('re-send with no new guests reports reached=0 and sends nothing', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    await insertGuest(pool, { phone: '919700000004', name: 'Only Guest', state: 'in_stay' });
    const first = await createAndBroadcastActivity({
      date: istDate(0), time: '8 pm', eventName: 'Walking Tour', description: null, broadcast: true,
    });
    assert.equal(first.reached, 1);
    const before = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    const resend = await broadcastActivityById(first.activityId);
    assert.equal(resend.reached, 0, 'no duplicate sends');
    const after = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    assert.equal(after, before, 'message count unchanged');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('editing the content makes the activity sendable again — everyone gets the new version', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const a = await insertGuest(pool, { phone: '919700000005', name: 'Content Guest', state: 'in_stay' });
    const first = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'DJ NIGHT', description: 'Cafe Zone', broadcast: true,
    });
    assert.equal(first.reached, 1);

    // identical content re-send → nothing
    const same = await broadcastActivityById(first.activityId);
    assert.equal(same.reached, 0, 'identical content never re-sends');

    // content edited → new version → sendable again
    await updateActivity(first.activityId, { description: 'Rooftop' });
    const resend = await broadcastActivityById(first.activityId);
    assert.equal(resend.reached, 1, 'changed content re-sends to the same guest');

    const versions = (await pool.query(
      `SELECT count(DISTINCT trigger_reason)::int AS n FROM messages WHERE trigger_reason LIKE 'activity:%'`
    )).rows[0].n;
    assert.equal(versions, 2, 'two distinct content versions delivered');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
