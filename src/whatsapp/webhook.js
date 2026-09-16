import { query } from '../db.js';
import { handleInboundCommand } from '../agent/triggers.js';
import { dispatchPending } from '../messaging/outbound.js';

export function handleVerification(q, verifyToken) {
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === verifyToken) {
    return { status: 200, body: String(q['hub.challenge'] ?? '') };
  }
  return { status: 403, body: 'Forbidden' };
}

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export async function handleEvent(payload) {
  const entries = payload?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (Array.isArray(value.statuses)) await processStatuses(value.statuses);
      if (Array.isArray(value.messages)) await processInbound(value);
    }
  }
}

async function processStatuses(statuses) {
  for (const s of statuses) {
    if (!s.id || !s.status || !(s.status in STATUS_RANK)) continue;
    const rows = await query('SELECT id, status FROM messages WHERE wa_message_id = $1', [s.id]);
    const msg = rows[0];
    if (!msg) {
      console.warn(`[webhook] status ${s.status} for unknown wa_message_id ${s.id}`);
      continue;
    }
    if (msg.status !== 'failed' && STATUS_RANK[msg.status] >= STATUS_RANK[s.status]) continue;
    const error =
      s.status === 'failed' && s.errors?.[0]
        ? `${s.errors[0].title ?? ''}: ${s.errors[0].message ?? ''}`.trim()
        : null;
    await query(
      'UPDATE messages SET status = $1, last_error = $2, updated_at = now() WHERE id = $3',
      [s.status, error, msg.id]
    );
  }
}

async function processInbound(value) {
  const messages = value.messages ?? [];
  if (messages.length === 0) return;
  const waId = messages[0].from;
  if (!waId) return;
  const profileName = value.contacts?.[0]?.profile?.name ?? null;

  const existing = await query('SELECT id FROM guests WHERE phone = $1', [waId]);
  let guestId;
  if (existing.length > 0) {
    guestId = existing[0].id;
  } else {
    const inserted = await query(
      `INSERT INTO guests (phone, name, property)
       VALUES ($1, $2, 'Zostel Mumbai')
       RETURNING id`,
      [waId, profileName || `Guest ${waId.slice(-4)}`]
    );
    guestId = inserted[0].id;
    console.log(`[webhook] new guest created from inbound message: ${waId}`);
  }

  for (const m of messages) {
    const text = m.text?.body ?? `[${m.type ?? 'unknown'}]`;
    await query(
      `INSERT INTO messages (guest_id, direction, content, message_type, status, trigger_reason, wa_message_id)
       VALUES ($1, 'in', $2, 'free_text', 'delivered', 'inbound_whatsapp', $3)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [guestId, text, m.id]
    );
    const cmd = m.type === 'text' ? text.trim().toUpperCase() : '';
    if (cmd === 'STOP' || cmd === 'START') {
      const reply = await handleInboundCommand(guestId, cmd);
      if (reply) await dispatchPending();
    }
  }
}
