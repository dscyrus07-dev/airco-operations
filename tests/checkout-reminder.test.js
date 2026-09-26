// FIX 5 (H4) + H6 tests: single checkout-reminder trigger, backdated gates.
// DB-backed — skips when the test database (docker compose) is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';
// dummy Twilio/config env so getConfig() works in the test process
process.env.TWILIO_ACCOUNT_SID ??= 'ACtesttesttesttesttesttesttesttest';
process.env.TWILIO_AUTH_TOKEN ??= 'test-token';
process.env.TWILIO_WHATSAPP_FROM ??= 'whatsapp:+91000000000';
process.env.BOOKING_WEBHOOK_SECRET ??= 'test-secret';

const { withDb, cleanTables, insertGuest, insertBooking } = await import('./db-helper.js');
const { runJourneyScheduler } = await import('../src/agent/bulk-import.js');
const { runDateTick, handleBookingWebhook } = await import('../src/agent/triggers.js');

function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

test('FIX 5 #1: bookings-driven reminder fires once, transitions to checkout_pending, idempotent', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919300000001', name: 'Stay', state: 'in_stay', checkIn: istDate(-1), checkOut: istDate(0) });
    await insertBooking(pool, { guestId: g.id, resNo: 'ZM950001', arrival: `${istDate(-1)} 13:00`, departure: `${istDate(0)} 10:00` });
    await pool.query(`UPDATE bookings SET checkout_reminder_due_at = now() - interval '1 hour'`);
    await runJourneyScheduler();
    let msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].template_name, 'checkout_reminder');
    let guest = (await pool.query('SELECT journey_state FROM guests WHERE id = $1', [g.id])).rows[0];
    assert.equal(guest.journey_state, 'checkout_pending');
    const ev = (await pool.query(`SELECT event FROM journey_events WHERE guest_id = $1`, [g.id])).rows[0];
    assert.equal(ev.event, 'checkout_reminder_tick');
    await runJourneyScheduler(); // second run — must not duplicate
    msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.length, 1, 'scheduler is idempotent');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 5 #2: manually-added guest gets a bookings row with 13:00 IST checkout due', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const guest = await handleBookingWebhook({
      phone: '919300000002', name: 'Manual Guest',
      check_in: istDate(1), check_out: istDate(3), room: '207',
    });
    const b = (await pool.query('SELECT * FROM bookings WHERE guest_id = $1', [guest.id])).rows[0];
    assert.ok(b, 'bookings row created for manual guest');
    assert.equal(b.classification, 'BOOKING');
    assert.equal(b.pre_arrival_due_at, null, 'no +1h pre-arrival for manual adds');
    // departure date at 13:00 IST == 07:30 UTC
    const [y, m, d] = istDate(3).split('-').map(Number);
    assert.equal(new Date(b.checkout_reminder_due_at).toISOString(), new Date(Date.UTC(y, m - 1, d, 7, 30)).toISOString());
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 5 #3: legacy day-before tick no longer fires checkout reminders', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919300000003', name: 'Legacy', state: 'in_stay', checkIn: istDate(-2), checkOut: istDate(1) });
    await runDateTick(new Date()); // any hour — the retired block must never fire
    const msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.filter((m) => m.template_name === 'checkout_reminder').length, 0);
    const guest = (await pool.query('SELECT journey_state FROM guests WHERE id = $1', [g.id])).rows[0];
    assert.equal(guest.journey_state, 'in_stay'); // no checkout_pending transition either
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('H6 #1: backdated booking (departure in the past) → skipped, never messaged', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919300000004', name: 'Backdated', state: 'in_stay', checkIn: istDate(-5), checkOut: istDate(-1) });
    await insertBooking(pool, { guestId: g.id, resNo: 'ZM950002', arrival: `${istDate(-5)} 13:00`, departure: `${istDate(-1)} 10:00` });
    await pool.query(`UPDATE bookings SET checkout_reminder_due_at = now() - interval '2 hours'`);
    await runJourneyScheduler();
    const msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.length, 0, 'no checkout reminder for a past departure');
    const b = (await pool.query('SELECT checkout_reminder_status FROM bookings')).rows[0];
    assert.equal(b.checkout_reminder_status, 'skipped_backdated');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('H6 #2: reminder due more than 24h ago → skipped_stale', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919300000005', name: 'Stale', state: 'in_stay', checkIn: istDate(-1), checkOut: istDate(3) });
    await insertBooking(pool, { guestId: g.id, resNo: 'ZM950003', arrival: `${istDate(-1)} 13:00`, departure: `${istDate(3)} 10:00` });
    await pool.query(`UPDATE bookings SET checkout_reminder_due_at = now() - interval '30 hours'`);
    await runJourneyScheduler();
    const msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.length, 0);
    const b = (await pool.query('SELECT checkout_reminder_status FROM bookings')).rows[0];
    assert.equal(b.checkout_reminder_status, 'skipped_stale');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('H6 #3: pre-arrival for an arrival already past → skipped_backdated', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919300000006', name: 'LateImport', state: 'booked' });
    await insertBooking(pool, { guestId: g.id, resNo: 'ZM950004', arrival: `${istDate(-2)} 13:00`, departure: `${istDate(2)} 10:00` });
    await pool.query(`UPDATE bookings SET pre_arrival_due_at = now() - interval '1 hour'`);
    await runJourneyScheduler();
    const msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
    assert.equal(msgs.length, 0, 'no pre-arrival for a past arrival');
    const b = (await pool.query('SELECT pre_arrival_status FROM bookings')).rows[0];
    assert.equal(b.pre_arrival_status, 'skipped_backdated');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
