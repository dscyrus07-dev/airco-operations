import { query } from '../db.js';
import { transition } from './journey.js';
import { canSendProactive } from './policy.js';
import { queueMessage, dispatchPending } from '../messaging/outbound.js';
import { getConfig } from '../config.js';

export function normalizePhone(raw) {
  return String(raw ?? '').replace(/[^\d]/g, '');
}

export function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function findGuestByPhone(phone) {
  const rows = await query('SELECT * FROM guests WHERE phone = $1', [normalizePhone(phone)]);
  return rows[0] ?? null;
}

export async function handleBookingWebhook(b) {
  const phone = normalizePhone(b?.phone);
  if (!phone) throw new Error('booking webhook: phone is required');
  const name = String(b?.name ?? '').trim();
  if (!name) throw new Error('booking webhook: name is required');
  const rows = await query(
    `INSERT INTO guests (phone, name, property, room, check_in, check_out, journey_state, whatsapp_opt_in)
     VALUES ($1, $2, $3, $4, $5, $6, 'booked', $7)
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       room = EXCLUDED.room,
       check_in = EXCLUDED.check_in,
       check_out = EXCLUDED.check_out,
       whatsapp_opt_in = EXCLUDED.whatsapp_opt_in
     RETURNING *`,
    [
      phone,
      name,
      b?.property || getConfig().property,
      b?.room ?? null,
      normalizeDate(b?.check_in),
      normalizeDate(b?.check_out),
      b?.whatsapp_opt_in === true || b?.whatsapp_opt_in === 'true',
    ]
  );
  const guest = rows[0];
  // Manually-added guests join the SAME bookings-driven scheduler as sheet
  // imports: pre-arrival on the next tick, checkout reminder the night
  // before departure at 20:00 IST.
  if (guest?.check_out) {
    // pg returns DATE columns as JS Dates — normalize to the IST calendar date
    const co = guest.check_out instanceof Date
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(guest.check_out)
      : String(guest.check_out).slice(0, 10);
    const [y, m, d] = co.split('-').map(Number);
    const dueAt = new Date(Date.UTC(y, m - 1, d - 1, 14, 30)); // night before, 20:00 IST == 14:30 UTC
    const preArrivalDue = new Date();
    const existingManual = await query(
      'SELECT id FROM bookings WHERE guest_id = $1 AND reservation_number IS NULL LIMIT 1',
      [guest.id]
    );
    if (existingManual.length > 0) {
      await query(
        `UPDATE bookings SET arrival = $2, departure = $3, checkout_reminder_due_at = $4,
           room_number = COALESCE($5, room_number), classification = 'BOOKING',
           pre_arrival_due_at = COALESCE(pre_arrival_due_at, $6)
         WHERE id = $1`,
        [existingManual[0].id, guest.check_in, guest.check_out, dueAt, guest.room, preArrivalDue]
      );
    } else {
      await query(
        `INSERT INTO bookings (guest_id, guest_name, contact_number, room_number,
           arrival, departure, classification, pre_arrival_due_at, checkout_reminder_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'BOOKING', $7, $8)`,
        [guest.id, guest.name, guest.phone, guest.room, guest.check_in, guest.check_out, preArrivalDue, dueAt]
      );
    }
  }
  return guest;
}

export async function applyEventToGuest(guest, eventName, detail, asOf = new Date()) {
  const t = transition(guest.journey_state, eventName);
  if (!t.ok) {
    console.warn(
      `[journey] rejected ${eventName} for guest ${guest.id} in ${guest.journey_state}: ${t.reason}`
    );
    return { transitioned: false, reason: t.reason, queued: null };
  }

  if (t.to !== guest.journey_state) {
    await query('UPDATE guests SET journey_state = $1 WHERE id = $2', [t.to, guest.id]);
    await query(
      `INSERT INTO journey_events (guest_id, from_state, to_state, event, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [guest.id, guest.journey_state, t.to, eventName, detail ?? null]
    );
    guest.journey_state = t.to;
  } else if (eventName === 'booking_created') {
    await query(
      `INSERT INTO journey_events (guest_id, from_state, to_state, event, detail)
       VALUES ($1, NULL, $2, $3, $4)`,
      [guest.id, t.to, eventName, detail ?? null]
    );
  }

  let queued = null;
  if (t.message) {
    queued = await maybeQueueProactive(guest, t.message, t.messageKind, eventName, asOf);
  }
  // FIX 2 (C2): after checkout, hand the guest row over to a future
  // reservation if one exists, so the new stay can be checked in.
  if (t.to === 'checked_out') {
    const { handoverToFutureBooking } = await import('./bulk-import.js');
    await handoverToFutureBooking(guest.id).catch((err) =>
      console.error('[journey] future-booking handover error:', err)
    );
  }
  await dispatchPending();
  return { transitioned: true, to: t.to, queued };
}

async function maybeQueueProactive(guest, templateName, kind, triggerEvent, asOf) {
  const cfg = getConfig();
  const { buildTemplateVars, buildTemplateComponents, renderTemplateText } = await import('../templates/store.js');
  const vars = await buildTemplateVars(templateName, guest);
  const [proactiveSentToday, openRequestCount, sessionOpen] = await Promise.all([
    countProactiveToday(guest.id, asOf),
    countOpenRequests(guest.id),
    hasOpenSession(guest.id, asOf),
  ]);
  const decision = canSendProactive({
    guest,
    proactiveSentToday,
    openRequestCount,
    kind,
    cap: cfg.proactiveDailyCap,
  });
  if (!decision.ok) {
    console.warn(`[policy] suppressed ${templateName} for guest ${guest.id}: ${decision.reason}`);
    return null;
  }
  const triggerReason = `${triggerEvent}:policy_ok`;
  const payload = sessionOpen
    ? {
        guestId: guest.id,
        content: await renderTemplateText(templateName, vars),
        messageType: 'free_text',
        templateName,
        triggerReason,
      }
    : {
        guestId: guest.id,
        messageType: 'template',
        templateName,
        templateComponents: await buildTemplateComponents(templateName, vars),
        triggerReason,
      };
  // FIX 9 (M5): the cap is enforced atomically at queue time (guest row locked
  // FOR UPDATE) — two concurrent sends cannot both slip under the cap. The
  // count definition is unchanged from countProactiveToday (policy_ok only).
  const { queueProactiveCapped } = await import('../messaging/outbound.js');
  return queueProactiveCapped(payload, cfg.proactiveDailyCap,
    `SELECT count(*)::int AS n FROM messages
     WHERE guest_id = $1 AND direction = 'out' AND trigger_reason LIKE '%:policy_ok'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [guest.id]);
}

// WhatsApp 24h session window: open if the guest messaged us in the last 24h.
async function hasOpenSession(guestId, asOf = new Date()) {
  const since = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
  const rows = await query(
    `SELECT 1 FROM messages
     WHERE guest_id = $1 AND direction = 'in' AND created_at > $2
     LIMIT 1`,
    [guestId, since]
  );
  return rows.length > 0;
}

export async function countProactiveToday(guestId, asOf) {
  const rows = await query(
    `SELECT count(*)::int AS n FROM messages
     WHERE guest_id = $1
       AND direction = 'out'
       AND trigger_reason LIKE '%:policy_ok'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
           = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
    [guestId, asOf]
  );
  return rows[0].n;
}

export async function countOpenRequests(guestId) {
  const rows = await query(
    `SELECT count(*)::int AS n FROM requests WHERE guest_id = $1 AND status <> 'completed'`,
    [guestId]
  );
  return rows[0].n;
}

// Deterministic guest commands from WhatsApp replies. Exact match only —
// never the LLM's decision. STOP unsubscribes from activity broadcasts,
// START resubscribes. Both reply with a confirmation within the session.
export async function handleInboundCommand(guestId, command) {
  if (command === 'STOP') {
    const rows = await query(
      `UPDATE guests SET activities_opt_out = TRUE
       WHERE id = $1 AND activities_opt_out = FALSE RETURNING id`,
      [guestId]
    );
    if (rows.length === 0) return null;
    const msg = await queueMessage({
      guestId,
      content: 'You will no longer receive activity updates. Reply START anytime to get them back.',
      messageType: 'free_text',
      triggerReason: 'stop_command',
    });
    return msg;
  }
  if (command === 'START') {
    const rows = await query(
      `UPDATE guests SET activities_opt_out = FALSE
       WHERE id = $1 AND activities_opt_out = TRUE RETURNING id`,
      [guestId]
    );
    if (rows.length === 0) return null;
    const msg = await queueMessage({
      guestId,
      content: 'Welcome back! You will receive activity updates again.',
      messageType: 'free_text',
      triggerReason: 'start_command',
    });
    return msg;
  }
  return null;
}

export async function runDateTick(asOf = new Date()) {
  // Message sends are no longer date-tick driven: pre-arrival fires on
  // import via runJourneyScheduler, welcome fires on staff check-in, the
  // checkout reminder fires the night before departure via the scheduler,
  // and review requests are staff-selected. What remains here is the
  // state-only in-stay transition for checked-in guests.
  const inStay = await query(
    `SELECT * FROM guests
     WHERE journey_state = 'checked_in' AND archived = FALSE
       AND check_in <= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
    [asOf]
  );
  for (const g of inStay) {
    await applyEventToGuest(g, 'in_stay_tick', `date_tick check_in=${g.check_in}`, asOf);
  }
}
