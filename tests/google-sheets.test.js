// Google Sheets integration tests: TSV conversion, auth URL, state flow,
// and syncNow feeding the EXISTING importer (fetch stubbed).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';
process.env.TWILIO_ACCOUNT_SID ??= 'ACtesttesttesttesttesttesttesttest';
process.env.TWILIO_AUTH_TOKEN ??= 'test-token';
process.env.TWILIO_WHATSAPP_FROM ??= 'whatsapp:+91000000000';
process.env.BOOKING_WEBHOOK_SECRET ??= 'test-secret';
process.env.GOOGLE_SHEETS_ENABLED = 'true';
process.env.GOOGLE_SHEET_ID = 'SHEET123';
process.env.GOOGLE_SHEET_TAB = 'Hotel Report';
process.env.GOOGLE_SHEET_RANGE = 'A:R';
process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN ??= 'test-refresh-token';

const { withDb, cleanTables } = await import('./db-helper.js');
const gs = await import('../src/integrations/google-sheets.js');
const { parseBulkReport } = await import('../src/agent/bulk-parse.js');

test('redirectUri is the exact production callback', () => {
  assert.equal(gs.redirectUri('https://airco-operations-production.up.railway.app/'),
    'https://airco-operations-production.up.railway.app/admin/google/callback');
});

test('buildAuthUrl requests offline access with the read-only scope', () => {
  const url = new URL(gs.buildAuthUrl({
    clientId: 'CID', redirect: 'https://x.test/admin/google/callback', state: 'ST',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'CID');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.test/admin/google/callback');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'ST');
});

test('rowsToTsv converts sheet rows into parser-ready tab-separated text', () => {
  const rows = [
    ['Emp name', 'Res. No', 'Contact Number', 'Guest', 'Room No.'],
    ['Sumit', 'ZM1', '8103370439', 'Vedank Agrawal', '305'],
    ['Sumit', null, null, 'Ayushman', null], // non-booking row
  ];
  const tsv = gs.rowsToTsv(rows);
  assert.equal(tsv.split('\n').length, 3);
  assert.match(tsv.split('\n')[1], /^Sumit\tZM1\t8103370439\tVedank Agrawal\t305$/);
  assert.ok(!tsv.includes('\t\t\t\t\n'), 'no stray tab runs from null cells');
});

// Real-world sheet shape: title + subtitle + empty row + header at line 4 +
// data. The parser must find the header row, skip the preamble, and use tabs.
test('parser handles the real sheet layout (title rows before the header)', () => {
  const tsv = [
    'ZOSTEL MUMBAI  |  RESERVATION & PAYMENT REPORT',
    'Hotel Operations • Paste hotel report rows from row 5 • Nights and Balance Due calculate automatically',
    ['Emp name', 'Res. No', 'Contact Number', 'Guest', 'Room No.', 'Rate(Rs)', 'Arrival', 'Departure', 'Nights', 'Pax', 'Res.Type', 'Deposit(Rs)', 'Balance Due(Rs)', 'Business Source'].join('\t'),
    ['shahvez', 'ZM1352311', '8855994761', 'Manish Sharma', '103-1', '1,318.99', '28-09-2026 13:00', '01-10-2026 10:00', '3', '1 / 0', 'Confirm Booking', '4,154.85', '0.00', 'Makemytrip'].join('\t'),
  ].join('\n');
  const parsed = parseBulkReport(tsv);
  assert.ok(parsed.headers, 'header row detected below the preamble');
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.classification, 'BOOKING');
  assert.equal(row.parsed.guest_name, 'Manish Sharma');
  assert.equal(row.parsed.reservation_number, 'ZM1352311');
  assert.equal(row.parsed.contact_number, '918855994761');
  assert.equal(row.resType, 'CONFIRM_BOOKING');
  assert.equal(row.parsed.room_number, '103-1');
});

test('syncNow feeds fetched rows into the EXISTING importer (fetch stubbed)', async (t) => {
  const r = await withDb(async (pool) => {
    await cleanTables(pool);
    const header = ['Emp name', 'Res. No', 'Contact Number', 'Guest', 'Room No.', 'Rate(Rs)', 'Arrival', 'Departure', 'Nights', 'Pax', 'Res.Type', 'Deposit(Rs)', 'Balance Due(Rs)', 'Business Source'];
    const d = (n) => {
      const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400_000));
      const [y, m, dd] = iso.split('-');
      return `${dd}-${m}-${y}`;
    };
    const sheetRows = [
      header,
      ['Sumit', 'ZMGS001', '919600000001', 'Sheet Guest', '301', '1000', `${d(1)} 13.00`, `${d(2)} 10.00`, '1', '2 / 0', 'Confirm Booking', '0', '1000', 'Booking.com'],
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
      }
      if (u.includes('sheets.googleapis.com/v4/spreadsheets/SHEET123')) {
        return { ok: true, json: async () => ({ values: sheetRows }) };
      }
      return realFetch(url, opts);
    };
    try {
      const out = await gs.syncNow();
      assert.equal(out.ok, true);
      assert.equal(out.summary.bookings, 1);
      assert.equal(out.summary.confirmationsQueued, 1);
      const guest = (await pool.query(`SELECT name, journey_state FROM guests WHERE phone = '919600000001'`)).rows[0];
      assert.equal(guest.name, 'Sheet Guest');
      assert.equal(guest.journey_state, 'booked');
      const msgs = (await pool.query(`SELECT template_name FROM messages`)).rows;
      assert.deepEqual(msgs.map((m) => m.template_name), ['booking_confirmation']);
      const last = await gs.getLastSync();
      assert.equal(last.ok, true);
      assert.equal(last.rows, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});

test('OAuth state is single-use', async (t) => {
  const r = await withDb(async () => {
    const state = await gs.issueState();
    assert.equal(await gs.consumeState(state), true, 'first use valid');
    assert.equal(await gs.consumeState(state), false, 'second use rejected');
    assert.equal(await gs.consumeState('forged'), false);
    return true;
  });
  if (r.skipped) t.skip(r.reason);
});
