import { query } from '../db.js';
import { sendText, sendTemplate, isRetryableError, fetchMessageStatus } from '../whatsapp/client.js';

const MAX_ATTEMPTS = 5;
// FIX 4 (H3): retries are SCHEDULED, never inline. One attempt per message per
// dispatch pass; a failing message is rescheduled with exponential backoff and
// the loop moves on immediately.
const RETRY_BACKOFF_MINUTES = [1, 2, 4, 8, 16];
// FIX 3 (H2): a claim older than this means the dispatcher died mid-send.
const CLAIM_STALE_MINUTES = 5;

let dispatching = false;

// Shared insert builder for queueMessage / queueProactiveCapped (FIX 9).
function messageInsert(payload) {
  return {
    sql: `INSERT INTO messages (guest_id, direction, content, message_type, template_name, template_components, status, trigger_reason)
          VALUES ($1, 'out', $2, $3, $4, $5::jsonb, 'queued', $6)
          RETURNING *`,
    params: [payload.guestId, payload.content, payload.messageType, payload.templateName,
      JSON.stringify(payload.templateComponents ?? []), payload.triggerReason],
  };
}

export async function queueMessage(
  {
    guestId,
    content = null,
    messageType,
    templateName = null,
    templateComponents = [],
    triggerReason,
  },
  client = null // optional transaction client (FIX 7) — pool by default
) {
  const run = client ? (sql, params) => client.query(sql, params).then((r) => r.rows) : query;
  const { sql, params } = messageInsert({ guestId, content, messageType, templateName, templateComponents, triggerReason });
  try {
    const rows = await run(sql, params);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      console.warn(`[outbound] duplicate suppressed: guest ${guestId}, template ${templateName}`);
      return null;
    }
    throw err;
  }
}

// FIX 9 (M5): atomic daily-cap queueing. A bare INSERT..SELECT WHERE count<cap
// is still racy under READ COMMITTED (concurrent statements snapshot before
// either commits), so the guest row is locked FOR UPDATE inside a transaction
// — concurrent sends for the SAME guest serialize; different guests never
// contend. The caller supplies its own count definition (legacy path counts
// policy_ok messages; the bookings scheduler counts all outbound templates).
export async function queueProactiveCapped(payload, cap, countSql, countParams) {
  const { getPool } = await import('../db.js');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM guests WHERE id = $1 FOR UPDATE', [payload.guestId]);
    const cnt = await client.query(countSql, countParams);
    if (cnt.rows[0].n >= cap) {
      await client.query('COMMIT');
      return null; // cap reached — suppressed
    }
    const { sql, params } = messageInsert(payload);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return null;
    throw err;
  } finally {
    client.release();
  }
}

export async function dispatchPending() {
  if (dispatching) return;
  dispatching = true;
  try {
    await reconcileStuckSending();
    const pending = await query(
      `SELECT m.id, m.guest_id, m.content, m.message_type, m.template_name, m.template_components, m.retry_count,
              g.phone, g.name AS guest_name, g.check_in, g.check_out, g.room
       FROM messages m JOIN guests g ON g.id = m.guest_id
       WHERE m.status = 'queued' AND m.next_attempt_at <= now()
       ORDER BY m.next_attempt_at, m.id
       LIMIT 50`
    );
    for (const msg of pending) {
      await sendOnce(msg);
    }
  } finally {
    dispatching = false;
  }
}

// FIX 3: atomically claim the row before sending. Only the owner sends —
// a second dispatcher (restart, second instance, concurrent tick) loses the
// race and skips, so no guest ever receives the same message twice from a
// crash between send and status-write.
async function claim(msgId) {
  const rows = await query(
    `UPDATE messages SET status = 'sending', claimed_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id`,
    [msgId]
  );
  return rows.length > 0;
}

async function sendOnce(msg) {
  if (!(await claim(msg.id))) return; // lost the claim race — skip
  try {
    const res =
      msg.message_type === 'template'
        ? await sendTemplate(msg.phone, msg.template_name, 'en', msg.template_components ?? [])
        : await sendText(msg.phone, msg.content);
    await query(
      `UPDATE messages SET status = 'sent', wa_message_id = $1, claimed_at = NULL, updated_at = now() WHERE id = $2`,
      [res.waMessageId, msg.id]
    );
    if (msg.template_name === 'review_request') await markReviewRequested(msg.guest_id);
  } catch (err) {
    const attempt = msg.retry_count + 1;
    const retryable = isRetryableError(err) && attempt < MAX_ATTEMPTS;
    if (retryable) {
      const backoffMin = RETRY_BACKOFF_MINUTES[Math.min(attempt - 1, RETRY_BACKOFF_MINUTES.length - 1)];
      await query(
        `UPDATE messages SET status = 'queued', retry_count = $1, last_error = $2,
           next_attempt_at = now() + ($3 || ' minutes')::interval, claimed_at = NULL, updated_at = now()
         WHERE id = $4`,
        [attempt, String(err.message).slice(0, 500), String(backoffMin), msg.id]
      );
      console.warn(`[outbound] message ${msg.id} attempt ${attempt} failed (retryable) — retry scheduled in ${backoffMin}m: ${err.message}`);
    } else {
      await query(
        `UPDATE messages SET status = 'failed', retry_count = $1, last_error = $2, claimed_at = NULL, updated_at = now() WHERE id = $3`,
        [attempt, String(err.message).slice(0, 500), msg.id]
      );
      console.error(`[outbound] message ${msg.id} FAILED permanently after ${attempt} attempts: ${err.message}`);
    }
  }
}

// FIX 3: messages stuck in 'sending' (crash between claim and status write)
// are reconciled — via Twilio's API when a SID was recorded — never blindly
// resent. Without a SID the send outcome is unknown, so the message is failed
// for manual review instead of risking a duplicate WhatsApp message.
async function reconcileStuckSending() {
  const stuck = await query(
    `SELECT id, wa_message_id FROM messages
     WHERE status = 'sending' AND claimed_at < now() - ($1 || ' minutes')::interval
     LIMIT 20`,
    [String(CLAIM_STALE_MINUTES)]
  );
  for (const m of stuck.rows ?? stuck) {
    if (m.wa_message_id) {
      const status = await fetchMessageStatus(m.wa_message_id).catch(() => null);
      if (status) {
        await query(
          `UPDATE messages SET status = $1, claimed_at = NULL, updated_at = now() WHERE id = $2`,
          [status, m.id]
        );
        continue;
      }
      // Twilio unreachable right now — leave claimed; reconciled next tick.
      continue;
    }
    await query(
      `UPDATE messages SET status = 'failed',
         last_error = 'claim expired without Twilio SID — send outcome unknown, manual review',
         claimed_at = NULL, updated_at = now()
       WHERE id = $1`,
      [m.id]
    );
    console.error(`[outbound] message ${m.id} stuck in sending without SID — failed for manual review`);
  }
}

export async function markReviewRequested(guestId) {
  const rows = await query(
    `UPDATE guests SET journey_state = 'review_requested'
     WHERE id = $1 AND journey_state = 'checked_out'
     RETURNING id`,
    [guestId]
  );
  if (rows.length > 0) {
    await query(
      `INSERT INTO journey_events (guest_id, from_state, to_state, event, detail)
       VALUES ($1, 'checked_out', 'review_requested', 'review_request_sent', 'review_request template sent')`,
      [guestId]
    );
    console.log(`[journey] guest ${guestId}: checked_out -> review_requested`);
  }
}
