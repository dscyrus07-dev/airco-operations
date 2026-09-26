// Bulk import execution + journey scheduler for the Zostel operational report.
// Parsing lives in bulk-parse.js; this module persists bookings, upserts
// guests, queues journey messages, and runs the pre-arrival/checkout schedulers.
import { query } from '../db.js';
import { getConfig } from '../config.js';
import { parseBulkReport } from './bulk-parse.js';
import { queueMessage } from '../messaging/outbound.js';

// Journey-state model (FIX 2 / C2 decision):
// journey_state stays PER-GUEST and represents the guest's CURRENT journey.
// A guest may hold many reservations (bookings is reservation-keyed). Rules:
//  - in-house states (checked_in/in_stay/checkout_pending): a new reservation
//    NEVER regresses state or overwrites stay data — it is recorded in
//    bookings only; its confirmation still fires.
//  - upcoming states (booked/pre_arrival): refresh stay data from the newest
//    reservation but keep the state (resetting pre_arrival would re-send).
//  - finished states (checked_out/review_requested/closed): the new
//    reservation starts a fresh journey -> 'booked' + unarchive.
const IN_HOUSE_STATES = ['checked_in', 'in_stay', 'checkout_pending'];
const JOURNEY_DONE_STATES = ['checked_out', 'review_requested', 'closed'];

async function upsertGuest(parsed) {
  const existing = await query(
    'SELECT id, journey_state FROM guests WHERE phone = $1',
    [parsed.contact_number]
  );
  if (existing.length > 0) {
    const g = existing[0];
    if (IN_HOUSE_STATES.includes(g.journey_state)) return g.id; // active stay untouched
    const startNewJourney = JOURNEY_DONE_STATES.includes(g.journey_state);
    await query(
      `UPDATE guests SET name = COALESCE(NULLIF($2, ''), name), room = COALESCE($3, room),
         check_in = COALESCE($4, check_in), check_out = COALESCE($5, check_out),
         journey_state = ${startNewJourney ? "'booked'" : 'journey_state'},
         archived = FALSE
       WHERE id = $1`,
      [g.id, parsed.guest_name, parsed.room_number, parsed.arrival, parsed.departure]
    );
    return g.id;
  }
  const rows = await query(
    `INSERT INTO guests (phone, name, property, room, check_in, check_out, journey_state, whatsapp_opt_in)
     VALUES ($1, $2, 'Zostel Mumbai', $3, $4, $5, 'booked', TRUE) RETURNING id`,
    [parsed.contact_number, parsed.guest_name, parsed.room_number, parsed.arrival, parsed.departure]
  );
  return rows[0].id;
}

// When a guest checks out and holds a FUTURE reservation, hand the guest row
// over to that booking so staff can check them in for the new stay (the state
// machine only allows checked_in from booked/pre_arrival).
export async function handoverToFutureBooking(guestId) {
  const future = await query(
    `SELECT id, reservation_number, room_number, arrival, departure FROM bookings
     WHERE guest_id = $1
       AND (departure AT TIME ZONE 'Asia/Kolkata')::date
           >= (now() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY arrival ASC LIMIT 1`,
    [guestId]
  );
  if (!future.length) return false;
  const b = future[0];
  const rows = await query(
    `UPDATE guests SET journey_state = 'booked',
       room = COALESCE($2, room),
       check_in = COALESCE(($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, check_in),
       check_out = COALESCE(($4::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, check_out)
     WHERE id = $1 AND journey_state = 'checked_out'
     RETURNING id`,
    [guestId, b.room_number, b.arrival, b.departure]
  );
  if (!rows.length) return false;
  await query(
    `INSERT INTO journey_events (guest_id, from_state, to_state, event, detail)
     VALUES ($1, 'checked_out', 'booked', 'future_booking_handover', $2)`,
    [guestId, b.reservation_number ? `reservation ${b.reservation_number}` : null]
  );
  return true;
}

export async function importBulkReport(text, { uploadedBy = 'dashboard', execute = false } = {}) {
  const { rows } = parseBulkReport(text);

  // duplicate detection against existing reservations
  const resNumbers = rows.filter((r) => r.parsed?.reservation_number).map((r) => r.parsed.reservation_number);
  const existing = resNumbers.length
    ? new Set((await query(
        `SELECT reservation_number FROM bookings WHERE reservation_number = ANY($1)`,
        [resNumbers]
      )).map((r) => r.reservation_number))
    : new Set();

  const summary = {
    total: rows.length, bookings: 0, nonBookings: 0, invalid: 0, duplicates: 0,
    confirmBookings: 0, confirmationsQueued: 0,
  };
  const results = [];

  if (!execute) {
    for (const row of rows) {
      const dup = row.parsed?.reservation_number && existing.has(row.parsed.reservation_number);
      if (row.classification === 'BOOKING') {
        summary.bookings++;
        if (row.resType === 'CONFIRM_BOOKING') summary.confirmBookings = (summary.confirmBookings ?? 0) + 1;
        if (dup) summary.duplicates++;
      } else if (row.classification === 'NON_BOOKING') summary.nonBookings++;
      else summary.invalid++;
      results.push({ guest: row.parsed?.guest_name ?? row.raw[3] ?? row.raw[0] ?? '', resNo: row.parsed?.reservation_number, phone: row.phone, room: row.parsed?.room_number, resType: row.resType, status: dup ? 'already imported — skipped' : row.error ?? row.classification, classification: dup ? 'DUPLICATE' : row.classification });
    }
    return { summary, results, dryRun: true };
  }

  // execute: create batch + persist
  const batch = (await query(
    `INSERT INTO import_batches (uploaded_by, row_count) VALUES ($1, $2) RETURNING id, imported_at`,
    [uploadedBy, rows.length]
  ))[0];

  for (const row of rows) {
    const dup = row.parsed?.reservation_number && existing.has(row.parsed.reservation_number);
    if (row.classification === 'NON_BOOKING') {
      summary.nonBookings++;
      await insertBookingRow(row, null, batch.id, 'NON_BOOKING');
      results.push({ guest: row.raw[3] ?? '', status: 'non-booking row — skipped', classification: 'NON_BOOKING' });
      continue;
    }
    if (row.classification === 'INVALID') {
      summary.invalid++;
      await insertBookingRow(row, null, batch.id, 'INVALID');
      results.push({ guest: row.raw[3] ?? row.raw[0] ?? '', status: `invalid: ${row.error}`, classification: 'INVALID' });
      continue;
    }
    summary.bookings++;
    if (row.resType === 'CONFIRM_BOOKING') summary.confirmBookings++;
    if (dup) {
      summary.duplicates++;
      results.push({ guest: row.parsed.guest_name, resNo: row.parsed.reservation_number, status: 'already imported — skipped', classification: 'DUPLICATE' });
      continue;
    }

    const guestId = await upsertGuest(row.parsed);
    await insertBookingRow(row, guestId, batch.id, 'BOOKING', { withSchedule: true });

    let confirmationStatus = `not_confirm_booking (${row.resType})`;
    if (row.resType === 'CONFIRM_BOOKING') {
      summary.confirmationsQueued++;
      await queueConfirmation(guestId, row.parsed);
      confirmationStatus = 'queued';
    }
    results.push({
      guest: row.parsed.guest_name,
      resNo: row.parsed.reservation_number,
      phone: '+' + row.parsed.contact_number,
      room: row.parsed.room_number,
      status: `booking added${row.resType === 'CONFIRM_BOOKING' ? ' · confirmation queued' : ''}`,
      classification: 'BOOKING',
    });
  }

  await query(
    `UPDATE import_batches SET booking_count=$1, non_booking_count=$2, invalid_count=$3, duplicate_count=$4 WHERE id=$5`,
    [summary.bookings, summary.nonBookings, summary.invalid, summary.duplicates, batch.id]
  );
  return { batchId: batch.id, importedAt: batch.imported_at, summary, results };
}

async function insertBookingRow(row, guestId, batchId, classification, opts = {}) {
  const p = row.parsed ?? {};
  const preArrivalDue = opts.withSchedule ? new Date(Date.now() + 3600_000) : null;
  const checkoutDue = opts.withSchedule && p.departure ? istDateAt1300(p.departure) : null;
  await query(
    `INSERT INTO bookings (reservation_number, guest_id, emp_name, contact_number, guest_name,
       room_number, rate, arrival, departure, nights, pax, reservation_type,
       deposit, balance_due, business_source, cash, card, upi, nos,
       raw_row, batch_id, classification, pre_arrival_due_at, checkout_reminder_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (reservation_number) WHERE reservation_number IS NOT NULL AND reservation_number <> ''
     DO NOTHING`,
    [p.reservation_number ?? null, guestId, p.emp_name, p.contact_number, p.guest_name,
     p.room_number, p.rate, p.arrival, p.departure, p.nights, p.pax, p.reservation_type,
     p.deposit, p.balance_due, p.business_source, p.cash, p.card, p.upi, p.nos,
     JSON.stringify(row.raw), batchId, classification, preArrivalDue, checkoutDue]
  );
}

// departure DATE at 13:00 Asia/Kolkata → UTC instant
function istDateAt1300(departure) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(departure);
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day, 7, 30)); // 13:00 IST == 07:30 UTC
}

async function queueConfirmation(guestId, parsed) {
  const { queueMessage } = await import('../messaging/outbound.js');
  const { buildTemplateVars } = await import('../templates/store.js');
  const guest = {
    id: guestId,
    name: parsed.guest_name,
    room: parsed.room_number,
    check_in: parsed.arrival?.toISOString?.().slice(0, 10),
    check_out: parsed.departure?.toISOString?.().slice(0, 10),
  };
  const vars = await buildTemplateVars('booking_confirmation', guest);
  // NOTE (FIX 2): journey_state / stay dates are managed by upsertGuest only —
  // the confirmation must never regress an in-house guest's state.
  await queueMessage({
    guestId,
    messageType: 'template',
    templateName: 'booking_confirmation',
    templateComponents: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })) }],
    triggerReason: 'bulk_import:booking_created',
  });
}

// YYYY-MM-DD in Asia/Kolkata — lexicographic date comparison for sanity gates.
function istDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

// Outbound template messages sent to a guest today (IST) — for the daily cap.
async function proactiveCountToday(guestId) {
  const rows = await query(
    `SELECT count(*)::int AS n FROM messages
     WHERE guest_id = $1 AND direction = 'out' AND message_type = 'template'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [guestId]
  );
  return rows[0].n;
}

// ---- journey scheduler: pre-arrival (+1h) and checkout reminder (1 PM) ----

export async function runJourneyScheduler() {
  // Pre-arrival: due 1 hour after import. Sends the approved checkin_info
  // template (our pre-arrival message). Idempotent via sent_at.
  const duePre = await query(
    `SELECT b.*, g.name AS g_name, g.journey_state, g.archived, g.whatsapp_opt_in, g.ai_paused
     FROM bookings b JOIN guests g ON g.id = b.guest_id
     WHERE b.classification = 'BOOKING'
       AND b.pre_arrival_due_at IS NOT NULL
       AND b.pre_arrival_sent_at IS NULL
       AND b.pre_arrival_due_at <= now()`
  );
  for (const b of duePre) {
    if (b.archived || b.whatsapp_opt_in === false) {
      await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'skipped' WHERE id = $1`, [b.id]);
      continue;
    }
    // H6 sanity gate: never pre-announce a stay whose arrival is already past.
    if (b.arrival && istDateStr(b.arrival) < istDateStr(new Date())) {
      await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'skipped_backdated' WHERE id = $1`, [b.id]);
      continue;
    }
    if (b.ai_paused) {
      await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'skipped_ai_paused' WHERE id = $1`, [b.id]);
      continue;
    }
    if ((await proactiveCountToday(b.guest_id)) >= getConfig().proactiveDailyCap) {
      await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'skipped_daily_cap' WHERE id = $1`, [b.id]);
      continue;
    }
    const already = await query(
      `SELECT 1 FROM messages WHERE guest_id = $1 AND template_name = 'checkin_info'
       AND status IN ('queued','sending','sent','delivered','read') LIMIT 1`,
      [b.guest_id]
    );
    if (already.length > 0) {
      await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'already_sent' WHERE id = $1`, [b.id]);
      continue;
    }
    const { buildTemplateVars } = await import('../templates/store.js');
    const vars = await buildTemplateVars('checkin_info', {
      name: b.g_name,
      check_in: b.arrival?.toISOString?.().slice(0, 10),
      check_out: b.departure?.toISOString?.().slice(0, 10),
    });
    await queueMessage({
      guestId: b.guest_id,
      messageType: 'template',
      templateName: 'checkin_info',
      templateComponents: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })) }],
      triggerReason: `bulk_import:pre_arrival:${b.id}`,
    });
    await query(`UPDATE bookings SET pre_arrival_sent_at = now(), pre_arrival_status = 'sent' WHERE id = $1`, [b.id]);
  }

  // Checkout reminder: due 13:00 IST on the departure date. Only guests still
  // in-house are eligible — already-checked-out guests are marked skipped.
  const dueCheckout = await query(
    `SELECT b.*, g.name AS g_name, g.journey_state, g.archived, g.whatsapp_opt_in, g.ai_paused
     FROM bookings b JOIN guests g ON g.id = b.guest_id
     WHERE b.classification = 'BOOKING'
       AND b.checkout_reminder_due_at IS NOT NULL
       AND b.checkout_reminder_sent_at IS NULL
       AND b.checkout_reminder_due_at <= now()`
  );
  for (const b of dueCheckout) {
    if (['checked_out', 'review_requested', 'closed'].includes(b.journey_state) || b.archived) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'skipped_already_checked_out' WHERE id = $1`, [b.id]);
      continue;
    }
    // H6 sanity gates: never remind about a stay whose departure is already
    // past, and never fire a reminder more than 24h stale.
    if (b.departure && istDateStr(b.departure) < istDateStr(new Date())) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'skipped_backdated' WHERE id = $1`, [b.id]);
      continue;
    }
    if (b.checkout_reminder_due_at < new Date(Date.now() - 86_400_000)) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'skipped_stale' WHERE id = $1`, [b.id]);
      continue;
    }
    if (b.ai_paused) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'skipped_ai_paused' WHERE id = $1`, [b.id]);
      continue;
    }
    if ((await proactiveCountToday(b.guest_id)) >= getConfig().proactiveDailyCap) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'skipped_daily_cap' WHERE id = $1`, [b.id]);
      continue;
    }
    const already = await query(
      `SELECT 1 FROM messages WHERE guest_id = $1 AND template_name = 'checkout_reminder'
       AND status IN ('queued','sending','sent','delivered','read') LIMIT 1`,
      [b.guest_id]
    );
    if (already.length > 0) {
      await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'already_sent' WHERE id = $1`, [b.id]);
      continue;
    }
    const { buildTemplateVars } = await import('../templates/store.js');
    const vars = await buildTemplateVars('checkout_reminder', { name: b.g_name });
    await queueMessage({
      guestId: b.guest_id,
      messageType: 'template',
      templateName: 'checkout_reminder',
      templateComponents: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })) }],
      triggerReason: `bulk_import:checkout_reminder:${b.id}`,
    });
    // FIX 5: the surviving trigger owns the checkout_pending transition that
    // the retired legacy tick used to perform.
    if (['checked_in', 'in_stay'].includes(b.journey_state)) {
      await query(
        `UPDATE guests SET journey_state = 'checkout_pending'
         WHERE id = $1 AND journey_state IN ('checked_in','in_stay')`,
        [b.guest_id]
      );
      await query(
        `INSERT INTO journey_events (guest_id, from_state, to_state, event, detail)
         VALUES ($1, $2, 'checkout_pending', 'checkout_reminder_tick', $3)`,
        [b.guest_id, b.journey_state, `checkout_reminder booking ${b.id}`]
      );
    }
    await query(`UPDATE bookings SET checkout_reminder_sent_at = now(), checkout_reminder_status = 'sent' WHERE id = $1`, [b.id]);
  }
  return { preArrival: duePre.length, checkout: dueCheckout.length };
}

// Manual template send (welcome / review) with dedupe.
export async function sendManualTemplate(guestIds, templateName) {
  const { queueMessage } = await import('../messaging/outbound.js');
  const sent = [];
  const skipped = [];
  for (const guestId of guestIds) {
    const guests = await query(
      'SELECT id, name, journey_state, whatsapp_opt_in, ai_paused FROM guests WHERE id = $1 AND archived = FALSE',
      [guestId]
    );
    if (!guests.length) { skipped.push({ id: guestId, reason: 'not found' }); continue; }
    const g = guests[0];
    if (g.whatsapp_opt_in === false) { skipped.push({ id: g.id, name: g.name, reason: 'opted out of WhatsApp' }); continue; }
    if (g.ai_paused) { skipped.push({ id: g.id, name: g.name, reason: 'AI paused' }); continue; }
    const already = await query(
      `SELECT 1 FROM messages WHERE guest_id = $1 AND template_name = $2
       AND status IN ('queued','sending','sent','delivered','read') LIMIT 1`,
      [g.id, templateName]
    );
    if (already.length > 0) { skipped.push({ id: g.id, name: g.name, reason: 'already sent' }); continue; }
    const { buildTemplateVars } = await import('../templates/store.js');
    const vars = await buildTemplateVars(templateName, g);
    const msg = await queueMessage({
      guestId: g.id,
      messageType: 'template',
      templateName,
      templateComponents: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })) }],
      triggerReason: `manual:${templateName}`,
    });
    if (msg) sent.push({ id: g.id, name: g.name });
    else skipped.push({ id: g.id, name: g.name, reason: 'duplicate suppressed' });
  }
  return { sent: sent.length, skipped };
}
