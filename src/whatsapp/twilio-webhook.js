import crypto from 'node:crypto';
import { query } from '../db.js';
import { handleInboundCommand } from '../agent/triggers.js';
import { dispatchPending } from '../messaging/outbound.js';
// Twilio sends webhook requests as application/x-www-form-urlencoded.
// Inbound message: MessageSid, From (whatsapp:+91...), ProfileName, Body, NumMedia...
// Status callback:  MessageSid, MessageStatus (queued|sent|delivered|read|failed|undelivered)

export function verifyTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], String(url));
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Twilio statuses -> our canonical statuses
const TWILIO_STATUS_MAP = {
  accepted: 'sent',
  queued: 'queued',
  scheduled: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
};
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export function classifyTwilioEvent(params) {
  const messageSid = params.MessageSid ?? params.SmsSid;
  const messageStatus = params.MessageStatus ?? params.SmsStatus;
  const from = params.From; // whatsapp:+919876543210

  if (messageStatus && messageSid && !params.From) {
    return { kind: 'status', messageSid, messageStatus };
  }
  if (from && from.startsWith('whatsapp:')) {
    const phone = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
    return { kind: 'inbound', phone };
  }
  return { kind: 'ignored' };
}

export async function handleTwilioEvent(params) {
  const messageSid = params.MessageSid ?? params.SmsSid;
  const messageStatus = params.MessageStatus ?? params.SmsStatus;
  const from = params.From; // whatsapp:+919876543210
  const body = params.Body ?? '';
  const profileName = params.ProfileName ?? null;

  if (messageStatus && messageSid && !params.From) {
    await applyTwilioStatus(messageSid, messageStatus, params.ErrorMessage ?? null);
    return { kind: 'status', messageSid, messageStatus };
  }

  if (from && from.startsWith('whatsapp:')) {
    const phone = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
    await ingestInboundText({ phone, profileName, text: body, waMessageId: messageSid });
    return { kind: 'inbound', phone };
  }

  return { ignored: true };
}

async function applyTwilioStatus(messageSid, twilioStatus, errorMessage) {
  const status = TWILIO_STATUS_MAP[twilioStatus];
  if (!status || !(status in STATUS_RANK)) return;
  const rows = await query('SELECT id, status FROM messages WHERE wa_message_id = $1', [messageSid]);
  const msg = rows[0];
  if (!msg) {
    console.warn(`[twilio webhook] status ${status} for unknown MessageSid ${messageSid}`);
    return;
  }
  if (msg.status !== 'failed' && STATUS_RANK[msg.status] >= STATUS_RANK[status]) return;
  await query('UPDATE messages SET status = $1, last_error = $2, updated_at = now() WHERE id = $3', [
    status,
    status === 'failed' ? (errorMessage ?? 'undelivered') : null,
    msg.id,
  ]);
}

export async function ingestInboundText({ phone, profileName, text, waMessageId }) {
  const existing = await query('SELECT id FROM guests WHERE phone = $1', [phone]);
  let guestId;
  if (existing.length > 0) {
    guestId = existing[0].id;
  } else {
    const inserted = await query(
      `INSERT INTO guests (phone, name, property, whatsapp_opt_in)
       VALUES ($1, $2, 'Zostel Mumbai', TRUE)
       RETURNING id`,
      [phone, profileName || `Guest ${phone.slice(-4)}`]
    );
    guestId = inserted[0].id;
    console.log(`[twilio] new guest created from inbound message: ${phone}`);
  }

  await query(
    `INSERT INTO messages (guest_id, direction, content, message_type, status, trigger_reason, wa_message_id)
     VALUES ($1, 'in', $2, 'free_text', 'delivered', 'inbound_whatsapp', $3)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [guestId, text, waMessageId]
  );

  const cmd = String(text ?? '').trim().toUpperCase();
  if (cmd === 'STOP' || cmd === 'START') {
    const reply = await handleInboundCommand(guestId, cmd);
    if (reply) await dispatchPending();
  }
  return guestId;
}
