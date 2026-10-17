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

test('resend flag reaches ONLY prior recipients — the confirm-resend path never doubles', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    await insertGuest(pool, { phone: '919700000010', name: 'Guest A', state: 'in_stay' });
    const first = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'Karaoke', description: null, broadcast: true,
    });
    assert.equal(first.reached, 1);
    assert.equal(first.alreadyReceived.length, 0, 'first send has no prior recipients');

    // plain re-send: nobody new → alreadyReceived reports who already got it
    const again = await broadcastActivityById(first.activityId);
    assert.equal(again.reached, 0);
    assert.equal(again.alreadyReceived.length, 1, 'dashboard can prompt for resend');
    assert.equal(again.alreadyReceived[0].name, 'Guest A');

    // staff confirmed → resend hits ONLY prior recipients
    const resend = await broadcastActivityById(first.activityId, { resend: true });
    assert.equal(resend.reached, 1, 'confirmed resend reaches the prior recipient');
    const msgs = (await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE trigger_reason LIKE 'activity:%'`
    )).rows;
    assert.equal(msgs[0].n, 2, 'guest now has two copies of this activity');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('activity sends are capped at 5 per guest per day', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    await insertGuest(pool, { phone: '919700000011', name: 'Cap Guest', state: 'in_stay' });
    let suppressedAt = null;
    for (let i = 1; i <= 7; i++) {
      const res = await createAndBroadcastActivity({
        date: istDate(0), time: `${i} pm`, eventName: `Event ${i}`, description: null, broadcast: true,
      });
      if (res.suppressed?.length && !suppressedAt) suppressedAt = i;
    }
    assert.equal(suppressedAt, 6, '6th activity of the day is suppressed');
    const n = (await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE trigger_reason LIKE 'activity:%'`
    )).rows[0].n;
    assert.equal(n, 5, 'exactly 5 activity sends landed');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('journey sends (welcome etc.) do not consume the activity allowance', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919700000012', name: 'Mixed Guest', state: 'in_stay' });
    // two proactive non-activity sends already today (welcome + checkin_info)
    await pool.query(
      `INSERT INTO messages (guest_id, direction, content, message_type, status, trigger_reason)
       VALUES ($1, 'out', 'x', 'template', 'sent', 'welcome:policy_ok'),
              ($1, 'out', 'x', 'template', 'sent', 'checkin_info:policy_ok')`,
      [g.id]
    );
    const res = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'Bonfire', description: null, broadcast: true,
    });
    assert.equal(res.reached, 1, 'activity still sends — its cap is separate');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('guestIds targets only the selected in-house guests', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const a = await insertGuest(pool, { phone: '919700000020', name: 'Picked', state: 'in_stay' });
    await insertGuest(pool, { phone: '919700000021', name: 'Skipped', state: 'in_stay' });
    const res = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'Quiz', description: null, broadcast: true,
      guestIds: [a.id],
    });
    assert.equal(res.reached, 1);
    assert.deepEqual(res.guests, ['Picked']);
    const rows = (await pool.query(
      `SELECT guest_id FROM messages WHERE trigger_reason LIKE 'activity:%'`
    )).rows;
    assert.equal(rows.length, 1, 'only the selected guest got it');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('guestIds never reaches guests who are not in-house', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919700000022', name: 'Departed', state: 'checked_out' });
    const res = await createAndBroadcastActivity({
      date: istDate(0), time: '9 pm', eventName: 'Quiz', description: null, broadcast: true,
      guestIds: [g.id],
    });
    assert.equal(res.reached, 0, 'checked-out guest excluded even when selected');
    const n = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    assert.equal(n, 0);
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
