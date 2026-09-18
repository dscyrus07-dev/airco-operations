import { query } from '../db.js';
import { canSendProactive } from './policy.js';
import { queueMessage, dispatchPending } from '../messaging/outbound.js';
import { countProactiveToday, countOpenRequests, normalizeDate } from './triggers.js';
import { getConfig } from '../config.js';

// Guests physically at the property — activity broadcasts target these.
const IN_PROPERTY_STATES = ['checked_in', 'in_stay', 'checkout_pending'];

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Deterministic activity rendering — engaging but never LLM-generated (Phase 1).
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
    `📅 ${date}\n` +
    `🕘 ${a.time}` +
    (a.description ? `\n📍 ${a.description}` : '') +
    `\n\nCome meet the hostel gang — see you there ✌️`
  );
}

// Community manager posts one activity; it is offered to every in-property
// guest individually through the policy engine. Nobody is messaged directly —
// every send is queued with a trigger reason and is auditable.
export async function createAndBroadcastActivity({ date, time, eventName, description }) {
  const cfg = getConfig();
  const cleanDate = normalizeDate(date);
  const cleanTime = String(time ?? '').trim();
  const cleanName = String(eventName ?? '').trim();
  if (!cleanDate) throw new Error('date is required (YYYY-MM-DD)');
  if (!cleanTime) throw new Error('time is required (e.g. 8 PM)');
  if (!cleanName) throw new Error('event name is required');

  const rows = await query(
    `INSERT INTO activities (property, date, time, event_name, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, time, event_name, description`,
    [cfg.property, cleanDate, cleanTime, cleanName, description ? String(description).trim() : null]
  );
  const activity = rows[0];

  const guests = await query(
    `SELECT id, name, phone, journey_state, ai_paused, activities_opt_out
     FROM guests
     WHERE journey_state = ANY($1)`,
    [IN_PROPERTY_STATES]
  );

  const queued = [];
  const suppressed = [];
  for (const g of guests) {
    const [sentToday, openRequests] = await Promise.all([
      countProactiveToday(g.id, new Date()),
      countOpenRequests(g.id),
    ]);
    const decision = canSendProactive({
      guest: g,
      proactiveSentToday: sentToday,
      openRequestCount: openRequests,
      kind: 'activity',
      cap: cfg.proactiveDailyCap,
    });
    if (!decision.ok) {
      suppressed.push({ guestId: g.id, name: g.name, reason: decision.reason });
      console.warn(`[activity ${activity.id}] suppressed for guest ${g.id}: ${decision.reason}`);
      continue;
    }
    const msg = await queueMessage({
      guestId: g.id,
      content: formatMessage(activity, cfg.property),
      messageType: 'free_text',
      triggerReason: `activity:${activity.id}:policy_ok`,
    });
    if (msg) queued.push({ guestId: g.id, name: g.name });
  }

  await dispatchPending();
  return {
    activityId: activity.id,
    eventName: cleanName,
    reached: queued.length,
    suppressed,
  };
}

export async function listActivities(limit = 20) {
  return query(
    `SELECT a.id, to_char(a.date, 'YYYY-MM-DD') AS date, a.time, a.event_name, a.description, a.status,
            (SELECT count(*)::int FROM messages m
              WHERE m.trigger_reason = 'activity:' || a.id || ':policy_ok') AS sent_count
     FROM activities a
     ORDER BY a.id DESC
     LIMIT $1`,
    [limit]
  );
}
