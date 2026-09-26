// FIX 2 (C2) tests: re-import must never regress an in-house guest's journey.
// DB-backed — skips when the test database (docker compose) is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';

const { withDb, cleanTables, insertGuest, insertBooking } = await import('./db-helper.js');
const { importBulkReport, handoverToFutureBooking } = await import('../src/agent/bulk-import.js');

const REPORT = (name, phone, res, room, arrival, departure) =>
  `Emp name\tRes. No\tContact Number\tGuest\tRoom No.\tRate(Rs)\tArrival\tDeparture\tNights\tPax\tRes.Type\tDeposit(Rs)\tBalance Due(Rs)\tBusiness Source\n` +
  `Sumit\t${res}\t${phone}\t${name}\t${room}\t1000\t${arrival}\t${departure}\t1\t2 / 0\tConfirm Booking\t0\t1000\tBooking.com`;

function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
}
// DATE columns come back as JS Dates (local-midnight UTC instants) — compare in IST.
const istOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
// report dates are DD-MM-YYYY HH.mm — like the real Zostel export
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${d}-${m}-${y}`; };

test('FIX 2 #1: brand-new guest + booking → booked, confirmation queued', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const out = await importBulkReport(REPORT('New Guest', '919100000001', 'ZM900001', '101', `${dmy(istDate(1))} 13.00`, `${dmy(istDate(2))} 10.00`), { execute: true });
    assert.equal(out.summary.bookings, 1);
    assert.equal(out.summary.confirmationsQueued, 1);
    const guest = (await pool.query('SELECT * FROM guests')).rows[0];
    assert.equal(guest.journey_state, 'booked');
    const msgs = (await pool.query(`SELECT template_name, status FROM messages`)).rows;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].template_name, 'booking_confirmation');
    assert.equal(msgs[0].status, 'queued');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 2 #2: in-house guest + new future booking → state preserved, confirmation still sent', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919100000002', name: 'In House', state: 'in_stay', checkIn: istDate(-1), checkOut: istDate(0) });
    const out = await importBulkReport(REPORT('In House', '919100000002', 'ZM900002', '202', `${dmy(istDate(3))} 13.00`, `${dmy(istDate(4))} 10.00`), { execute: true });
    assert.equal(out.summary.confirmationsQueued, 1);
    const guests = (await pool.query('SELECT * FROM guests')).rows;
    assert.equal(guests.length, 1, 'no second guest created for same phone');
    const guest = guests[0];
    assert.equal(guest.journey_state, 'in_stay'); // NOT regressed to booked
    assert.equal(istOf(guest.check_out), istDate(0)); // stay dates untouched
    const msgs = (await pool.query('SELECT template_name FROM messages')).rows;
    assert.deepEqual(msgs.map((m) => m.template_name).sort(), ['booking_confirmation']); // no welcome/pre-arrival
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 2 #3: closed guest + new booking → fresh journey (booked)', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919100000003', name: 'Returning', state: 'closed' });
    await importBulkReport(REPORT('Returning', '919100000003', 'ZM900003', '303', `${dmy(istDate(2))} 13.00`, `${dmy(istDate(3))} 10.00`), { execute: true });
    const guests = (await pool.query('SELECT * FROM guests')).rows;
    assert.equal(guests.length, 1);
    const guest = guests[0];
    assert.equal(guest.journey_state, 'booked');
    assert.equal(istOf(guest.check_in), istDate(2));
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 2 #4: re-import of the SAME reservation → duplicate skipped, no state change, no duplicate message', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const text = REPORT('Dup Guest', '919100000004', 'ZM900004', '404', `${dmy(istDate(1))} 13.00`, `${dmy(istDate(2))} 10.00`);
    await importBulkReport(text, { execute: true });
    const before = (await pool.query('SELECT journey_state FROM guests')).rows[0].journey_state;
    const msgCount1 = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    const out2 = await importBulkReport(text, { execute: true });
    assert.equal(out2.summary.duplicates, 1);
    assert.equal(out2.summary.confirmationsQueued, 0);
    const after = (await pool.query('SELECT journey_state FROM guests')).rows[0].journey_state;
    assert.equal(after, before);
    const msgCount2 = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    assert.equal(msgCount2, msgCount1);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 2 #5: checkout hands guest row over to a future reservation', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const g = await insertGuest(pool, { phone: '919100000005', name: 'Handover', state: 'checked_out', checkIn: istDate(-2), checkOut: istDate(-1) });
    await insertBooking(pool, { guestId: g.id, resNo: 'ZM900005', arrival: `${istDate(2)} 13:00`, departure: `${istDate(3)} 10:00`, room: '505' });
    const ok = await handoverToFutureBooking(g.id);
    assert.equal(ok, true);
    const guest = (await pool.query('SELECT * FROM guests WHERE id = $1', [g.id])).rows[0];
    assert.equal(guest.journey_state, 'booked');
    assert.equal(istOf(guest.check_in), istDate(2));
    assert.equal(istOf(guest.check_out), istDate(3));
    const ev = (await pool.query(`SELECT event FROM journey_events WHERE guest_id = $1`, [g.id])).rows[0];
    assert.equal(ev.event, 'future_booking_handover');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
