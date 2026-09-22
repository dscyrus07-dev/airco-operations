import { query } from '../db.js';
import { sendText, sendTemplate, isRetryableError } from '../whatsapp/client.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

let dispatching = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function queueMessage({
  guestId,
  content = null,
  messageType,
  templateName = null,
  templateComponents = [],
  triggerReason,
}) {
  try {
    const rows = await query(
      `INSERT INTO messages (guest_id, direction, content, message_type, template_name, template_components, status, trigger_reason)
       VALUES ($1, 'out', $2, $3, $4, $5::jsonb, 'queued', $6)
       RETURNING *`,
      [guestId, content, messageType, templateName, JSON.stringify(templateComponents), triggerReason]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      console.warn(`[outbound] duplicate suppressed: guest ${guestId}, template ${templateName}`);
      return null;
    }
    throw err;
  }
}

export async function dispatchPending() {
  if (dispatching) return;
  dispatching = true;
  try {
    const pending = await query(
      `SELECT m.id, m.guest_id, m.content, m.message_type, m.template_name, m.template_components, m.retry_count,
              g.phone, g.name AS guest_name, g.check_in, g.check_out, g.room
       FROM messages m JOIN guests g ON g.id = m.guest_id
       WHERE m.status = 'queued'
       ORDER BY m.id
       LIMIT 50`
    );
    for (const msg of pending) {
      await sendWithRetry(msg);
    }
  } finally {
    dispatching = false;
  }
}

async function sendWithRetry(msg) {
  let attempt = msg.retry_count;
  while (attempt < MAX_ATTEMPTS) {
    if (attempt > msg.retry_count) {
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
    try {
      const res =
        msg.message_type === 'template'
          ? await sendTemplate(msg.phone, msg.template_name, 'en', msg.template_components ?? [])
          : await sendText(msg.phone, msg.content);
      await query(
        `UPDATE messages SET status = 'sent', wa_message_id = $1, updated_at = now() WHERE id = $2`,
        [res.waMessageId, msg.id]
      );
      if (msg.template_name === 'review_request') await markReviewRequested(msg.guest_id);
      return;
    } catch (err) {
      attempt += 1;
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        await query(
          `UPDATE messages SET status = 'failed', retry_count = $1, last_error = $2, updated_at = now() WHERE id = $3`,
          [attempt, String(err.message).slice(0, 500), msg.id]
        );
        console.error(
          `[outbound] message ${msg.id} FAILED permanently after ${attempt} attempts: ${err.message}`
        );
        return;
      }
      await query(
        `UPDATE messages SET retry_count = $1, last_error = $2, updated_at = now() WHERE id = $3`,
        [attempt, String(err.message).slice(0, 500), msg.id]
      );
      console.warn(`[outbound] message ${msg.id} attempt ${attempt} failed (retryable): ${err.message}`);
    }
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
