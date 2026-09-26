// FIX 7 (H1) + FIX 10 (M4) tests: per-row transactions, accurate reporting.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';

const { withDb, cleanTables } = await import('./db-helper.js');
const { importBulkReport } = await import('../src/agent/bulk-import.js');

const HEAD = 'Emp name\tRes. No\tContact Number\tGuest\tRoom No.\tRate(Rs)\tArrival\tDeparture\tNights\tPax\tRes.Type\tDeposit(Rs)\tBalance Due(Rs)\tBusiness Source\n';
const row = (res, phone, name, room, arrival, departure, nights = '1') =>
  `Sumit\t${res}\t${phone}\t${name}\t${room}\t1000\t${arrival}\t${departure}\t${nights}\t2 / 0\tConfirm Booking\t0\t1000\tBooking.com`;

function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  const [y, m, dd] = iso.split('-');
  return `${dd}-${m}-${y}`;
}

test('FIX 7 #1: a row that throws mid-processing rolls back fully — no orphan guest/booking, batch reports failed', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    // nights = 99999999999 overflows INT4 → the bookings INSERT throws AFTER
    // the guest upsert inside the same row transaction.
    const text = HEAD
      + row('ZM960001', '919400000001', 'Good Row', '101', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`) + '\n'
      + row('ZM960002', '919400000002', 'Bad Row', '102', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`, '99999999999');
    const out = await importBulkReport(text, { execute: true });
    assert.equal(out.summary.bookings, 1, 'only the good row committed');
    assert.equal(out.summary.failed, 1, 'bad row reported as failed');
    const guests = (await pool.query('SELECT phone FROM guests')).rows.map((g) => g.phone);
    assert.deepEqual(guests, ['919400000001'], 'no orphan guest from the rolled-back row');
    const bookings = (await pool.query('SELECT reservation_number FROM bookings ORDER BY reservation_number')).rows.map((b) => b.reservation_number);
    assert.deepEqual(bookings, ['ZM960001'], 'no orphan booking from the rolled-back row');
    const msgs = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    assert.equal(msgs, 1, 'no confirmation message for the rolled-back row');
    const batch = (await pool.query('SELECT booking_count, failed_count FROM import_batches ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(batch.booking_count, 1);
    assert.equal(batch.failed_count, 1);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 10 #2: same reservation twice in ONE paste → second is DUPLICATE, not imported', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const text = HEAD
      + row('ZM960003', '919400000003', 'Dup Row', '103', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`) + '\n'
      + row('ZM960003', '919400000003', 'Dup Row', '103', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`);
    const out = await importBulkReport(text, { execute: true });
    assert.equal(out.summary.bookings, 1, 'only one booking imported');
    assert.equal(out.summary.duplicates, 1, 'in-paste duplicate classified');
    const dupResult = out.results.find((x) => x.classification === 'DUPLICATE');
    assert.ok(dupResult, 'duplicate row appears in per-row results');
    const bookings = (await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;
    assert.equal(bookings, 1);
    const msgs = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
    assert.equal(msgs, 1, 'exactly one confirmation');
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('FIX 7 #3: one failed row does not abort the rest of the paste', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const text = HEAD
      + row('ZM960004', '919400000004', 'First', '104', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`) + '\n'
      + row('ZM960005', '919400000005', 'Boom', '105', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`, '99999999999') + '\n'
      + row('ZM960006', '919400000006', 'Third', '106', `${istDate(1)} 13.00`, `${istDate(2)} 10.00`);
    const out = await importBulkReport(text, { execute: true });
    assert.equal(out.summary.bookings, 2, 'rows before AND after the failure committed');
    assert.equal(out.summary.failed, 1);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
