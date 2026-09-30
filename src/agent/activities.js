import { query } from '../db.js';
import { canSendProactive } from './policy.js';
import { queueMessage, dispatchPending } from '../messaging/outbound.js';
import { normalizeDate } from './triggers.js';
import { getConfig } from '../config.js';

// Guests physically at the property — activity broadcasts target these.
const IN_PROPERTY_STATES = ['checked_in', 'in_stay', 'checkout_pending'];

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Deterministic activity rendering — engaging but never LLM-generated (Phase 1).
import crypto from 'node:crypto';

// Template variables for the approved activity_notice template — must match
// its Meta-approved body order: {{1}} guest name, {{2}} event, {{3}} date,
// {{4}} time, {{5}} place.
function activityVars(a, property, guestName) {
  const date = new Date(`${a.date}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  return [guestName, a.event_name, date, a.time, a.description || property];
}

// Content hash — the same activity content never re-sends to a guest who
// already received it; editing the content or dates produces a new hash and
// becomes sendable again.
function activityContentHash(a) {
  return crypto.createHash('sha256')
    .update(`${a.event_name}|${a.date}|${a.time}|${a.description ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

// Deterministic activity rendering — engaging but never LLM-generated (Phase 1).
// Mirrors the approved activity_notice copy for the stored message record.
function formatMessage(a, property) {
  const date = new Date(`${a.date}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  const lead = a.date === istToday() ? "Today's plan" : 'Coming up';
  return (
    `👀 ${lead} at ${property}!\n\n` +
    `${a.event_name.toUpperCase()}\n` +
    `�️ ${date}\n` +
    `⏰ ${a.time}` +
    (a.description ? `\n📍 ${a.description}` : '') +
    `\n\nCome join us — see you there!`
  );
}

function cleanFields({ date, time, eventName, description }) {
  const cleanDate = normalizeDate(date);
  const cleanTime = String(time ?? '').trim();
  const cleanName = String(eventName ?? '').trim();
  if (!cleanDate) throw new Error('date is required (YYYY-MM-DD)');
  if (!cleanTime) throw new Error('time is required (e.g. 8 PM)');
  if (!cleanName) throw new Error('event name is required');
  return {
    cleanDate,
    cleanTime,
    cleanName,
    cleanDescription: description ? String(description).trim() : null,
  };
}

// Offer one activity to every in-property guest through the policy engine.
// Nobody is messaged directly — every send is queued with a trigger reason
// and is auditable. Used by both create-and-send and send-later.
// Per-CONTENT idempotency: the trigger reason carries a hash of the activity
// content, so the same message never sends twice, but editing the content
// (or dates) makes it sendable again. Guests who already received THIS
// exact version are excluded; the send goes out as an APPROVED TEMPLATE
// (activity_notice) so it reaches in-house guests without a 24h session.
async function broadcast(activity) {
  const cfg = getConfig();
  const guests = await query(
    `SELECT id, name, phone, journey_state, ai_paused, activities_opt_out
     FROM guests
     WHERE journey_state = ANY($1) AND archived = FALSE`,
    [IN_PROPERTY_STATES]
  );
  const contentHash = activityContentHash(activity);
  const triggerReason = `activity:${activity.id}:${contentHash}:policy_ok`;
  const prior = new Set((await query(
    `SELECT DISTINCT guest_id FROM messages
     WHERE trigger_reason = $1
       AND status IN ('queued','sending','sent','delivered','read')`,
    [triggerReason]
  )).map((r) => r.guest_id));
  const audience = guests.filter((g) => !prior.has(g.id));
  if (audience.length === 0) return { queued: [], suppressed: [] };
  const ids = guests.map((g) => g.id);
  const [sentRows, reqRows] = await Promise.all([
    query(
      `SELECT guest_id, count(*)::int AS n FROM messages
       WHERE guest_id = ANY($1) AND direction = 'out'
         AND trigger_reason LIKE '%:policy_ok'
         AND (created_at AT TIME ZONE 'Asia/Kolkata')::date
             = (now() AT TIME ZONE 'Asia/Kolkata')::date
       GROUP BY guest_id`,
      [ids]
    ),
    query(
      `SELECT guest_id, count(*)::int AS n FROM requests
       WHERE guest_id = ANY($1) AND status = 'open'
       GROUP BY guest_id`,
      [ids]
    ),
  ]);
  // query() already returns rows — `.rows` here was undefined and crashed
  // every broadcast with "Cannot read properties of undefined (reading 'map')".
  const sentMap = new Map(sentRows.map((r) => [r.guest_id, r.n]));
  const openReqMap = new Map(reqRows.map((r) => [r.guest_id, r.n]));

  const queued = [];
  const suppressed = [];
  for (const g of audience) {
    const decision = canSendProactive({
      guest: g,
      proactiveSentToday: sentMap.get(g.id) ?? 0,
      openRequestCount: openReqMap.get(g.id) ?? 0,
      kind: 'activity',
      cap: cfg.proactiveDailyCap,
    });
    if (!decision.ok) {
      suppressed.push({ guestId: g.id, name: g.name, reason: decision.reason });
      console.warn(`[activity ${activity.id}] suppressed for guest ${g.id}: ${decision.reason}`);
      continue;
    }
    const { getEffectiveBody, buildTemplateComponents } = await import('../templates/store.js');
    // While the 5-var template version is pending Meta approval, the active
    // body is still the 4-var one (no guest name) — match its positions.
    const effBody = await getEffectiveBody('activity_notice');
    const maxVar = (effBody.match(/{{(d+)}}/g) ?? [])
      .reduce((m, x) => Math.max(m, Number(x.match(/d+/)[0])), 0);
    const vars = maxVar >= 5
      ? activityVars(activity, cfg.property, g.name)
      : activityVars(activity, cfg.property, null).slice(1);
    const msg = await queueMessage({
      guestId: g.id,
      content: formatMessage(activity, cfg.property), // free-text fallback copy
      messageType: 'template',
      templateName: 'activity_notice',
      templateComponents: await buildTemplateComponents(
        'activity_notice', activityVars(activity, cfg.property, g.name)),
      triggerReason,
    });
    if (msg) queued.push({ guestId: g.id, name: g.name });
  }

  await dispatchPending();
  return { queued, suppressed };
}

// Create an activity. broadcast=true keeps the original one-shot behaviour
// (create + immediately offer to in-house guests). broadcast=false stores it
// as draft/scheduled for the dashboard to send later.
export async function createAndBroadcastActivity({ date, time, eventName, description, broadcast = true }) {
  const cfg = getConfig();
  const { cleanDate, cleanTime, cleanName, cleanDescription } = cleanFields({ date, time, eventName, description });

  const status = broadcast ? 'active' : cleanDate === istToday() ? 'draft' : 'scheduled';
  const rows = await query(
    `INSERT INTO activities (property, date, time, event_name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, time, event_name, description, status`,
    [cfg.property, cleanDate, cleanTime, cleanName, cleanDescription, status]
  );
  const activity = rows[0];
  if (!broadcast) {
    return { activityId: activity.id, eventName: cleanName, status, reached: 0, suppressed: [] };
  }
  const result = await broadcastActivityById(activity.id);
  return { activityId: activity.id, eventName: cleanName, ...result };
}

// Run the policy-gated broadcast for a stored activity and mark it sent.
// Re-sends are allowed and idempotent per guest: only guests who have NOT
// already received this activity are messaged (new check-ins get it too).
export async function broadcastActivityById(id) {
  const rows = await query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, time, event_name, description, status, sent_at
     FROM activities WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) throw new Error('activity not found');
  const activity = rows[0];

  const { queued, suppressed } = await broadcast(activity);
  await dispatchPending();
  // sent_at marks the FIRST send; re-sends don't move it.
  await query(`UPDATE activities SET status = 'active', sent_at = COALESCE(sent_at, now()) WHERE id = $1`, [id]);
  return {
    reached: queued.length,
    suppressed,
    guests: queued.map((q) => q.name),
  };
}

export async function updateActivity(id, { date, time, eventName, description, status }) {
  const existing = await query('SELECT id, sent_at, status FROM activities WHERE id = $1', [id]);
  if (existing.length === 0) throw new Error('activity not found');
  // Sent activities CAN be edited: the content hash changes, so a re-send
  // treats it as a new version and reaches everyone again (per-guest dedupe
  // still prevents the identical content from sending twice).

  const updates = {};
  if (date !== undefined) {
    const clean = normalizeDate(date);
    if (!clean) throw new Error('date must be YYYY-MM-DD');
    updates.date = clean;
  }
  if (time !== undefined) {
    const t = String(time ?? '').trim();
    if (!t) throw new Error('time cannot be empty');
    updates.time = t;
  }
  if (eventName !== undefined) {
    const n = String(eventName ?? '').trim();
    if (!n) throw new Error('event name cannot be empty');
    updates.event_name = n;
  }
  if (description !== undefined) updates.description = description === null ? null : String(description).trim();
  if (status !== undefined) {
    if (!['draft', 'scheduled', 'cancelled'].includes(status)) {
      throw new Error('status must be draft, scheduled or cancelled');
    }
    updates.status = status;
  }
  if (Object.keys(updates).length === 0) throw new Error('nothing to update');

  const setSql = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
  const updated = await query(
    `UPDATE activities SET ${setSql} WHERE id = $${Object.keys(updates).length + 1}
     RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, time, event_name, description, status`,
    [...Object.values(updates), id]
  );
  return updated[0];
}

export async function deleteActivity(id) {
  const rows = await query('SELECT sent_at FROM activities WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error('activity not found');
  if (rows[0].sent_at) throw new Error('sent activities cannot be deleted (audit history)');
  await query('DELETE FROM activities WHERE id = $1', [id]);
  return { ok: true };
}

export async function getActivity(id) {
  const rows = await query(
    `SELECT a.id, to_char(a.date, 'YYYY-MM-DD') AS date, a.time, a.event_name, a.description, a.status, a.sent_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.trigger_reason = 'activity:' || a.id || ':policy_ok') AS sent_count
     FROM activities a WHERE a.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listActivities(limit = 50) {
  return query(
    `SELECT a.id, to_char(a.date, 'YYYY-MM-DD') AS date, a.time, a.event_name, a.description, a.status, a.sent_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.trigger_reason = 'activity:' || a.id || ':policy_ok') AS sent_count
     FROM activities a
     ORDER BY a.id DESC
     LIMIT $1`,
    [limit]
  );
}
