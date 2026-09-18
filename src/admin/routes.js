import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { getConfig } from '../config.js';
import {
  handleBookingWebhook,
  applyEventToGuest,
  normalizeDate,
  normalizePhone,
} from '../agent/triggers.js';
import { createAndBroadcastActivity, listActivities } from '../agent/activities.js';
import { queueMessage, dispatchPending } from '../messaging/outbound.js';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Fail-closed: no ADMIN_TOKEN configured -> every admin route refuses.
// Auth applies to /api/* only; the static page itself contains no secrets.
export function adminRouter() {
  const router = Router();

  router.use('/api', (req, res, next) => {
    const cfg = getConfig();
    if (!cfg.adminToken) {
      return res.status(503).json({ error: 'admin disabled: ADMIN_TOKEN not set' });
    }
    const provided = req.headers['x-admin-token'];
    if (!provided || !safeEqual(provided, cfg.adminToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  router.get('/api/guests', async (_req, res, next) => {
    try {
      const rows = await query(
        `SELECT g.id, g.phone, g.name, g.room,
                to_char(g.check_in, 'YYYY-MM-DD') AS check_in,
                to_char(g.check_out, 'YYYY-MM-DD') AS check_out,
                g.journey_state, g.ai_paused, g.created_at,
                (SELECT count(*) FROM messages m
                  WHERE m.guest_id = g.id AND m.direction = 'out' AND m.message_type = 'template'
                    AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date
                      = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS proactive_today
         FROM guests g
         ORDER BY g.id DESC
         LIMIT 500`
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/guests/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const guests = await query(
        `SELECT id, phone, name, property, room,
                to_char(check_in, 'YYYY-MM-DD') AS check_in,
                to_char(check_out, 'YYYY-MM-DD') AS check_out,
                journey_state, ai_paused, activities_opt_out, created_at
         FROM guests WHERE id = $1`,
        [id]
      );
      if (guests.length === 0) return res.status(404).json({ error: 'guest not found' });
      const [messages, events, requests] = await Promise.all([
        query(
          `SELECT id, direction, message_type, template_name, status, content, trigger_reason, wa_message_id, retry_count, last_error, created_at
           FROM messages WHERE guest_id = $1 ORDER BY id DESC LIMIT 100`,
          [id]
        ),
        query(
          `SELECT id, from_state, to_state, event, detail, created_at
           FROM journey_events WHERE guest_id = $1 ORDER BY id`,
          [id]
        ),
        query(
          `SELECT id, request_type, status, description, assigned_to, created_at, completed_at
           FROM requests WHERE guest_id = $1 ORDER BY id DESC LIMIT 20`,
          [id]
        ),
      ]);
      res.json({ guest: guests[0], messages, events, requests });
    } catch (err) {
      next(err);
    }
  });

  // Add a booking from the dashboard. Reuses the exact booking-webhook pipeline
  // (upsert + booking_created journey event + policy + outbound queue), so there
  // is a single code path for how guests enter the system.
  router.post('/api/guests', async (req, res, next) => {
    try {
      const guest = await handleBookingWebhook(req.body);
      const result = await applyEventToGuest(guest, 'booking_created', 'dashboard add');
      res.status(201).json({ guestId: guest.id, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/api/guests/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const b = req.body ?? {};
      const existing = await query('SELECT * FROM guests WHERE id = $1', [id]);
      if (existing.length === 0) return res.status(404).json({ error: 'guest not found' });

      const updates = {};
      if (b.name !== undefined) {
        const name = String(b.name).trim();
        if (!name) return res.status(400).json({ error: 'name cannot be empty' });
        updates.name = name;
      }
      if (b.phone !== undefined) {
        const phone = normalizePhone(b.phone);
        if (!/^\d{10,15}$/.test(phone)) {
          return res.status(400).json({ error: 'phone must be 10-15 digits (with country code)' });
        }
        const clash = await query('SELECT id FROM guests WHERE phone = $1 AND id <> $2', [phone, id]);
        if (clash.length > 0) return res.status(409).json({ error: 'another guest already has this number' });
        updates.phone = phone;
      }
      if (b.room !== undefined) updates.room = b.room === null || b.room === '' ? null : String(b.room).trim();
      if (b.check_in !== undefined) {
        updates.check_in = b.check_in === null || b.check_in === '' ? null : normalizeDate(b.check_in);
        if (b.check_in && !updates.check_in) return res.status(400).json({ error: 'check_in must be YYYY-MM-DD' });
      }
      if (b.check_out !== undefined) {
        updates.check_out = b.check_out === null || b.check_out === '' ? null : normalizeDate(b.check_out);
        if (b.check_out && !updates.check_out) return res.status(400).json({ error: 'check_out must be YYYY-MM-DD' });
      }
      if (b.ai_paused !== undefined) updates.ai_paused = b.ai_paused === true || b.ai_paused === 'true';
      if (b.activities_opt_out !== undefined)
        updates.activities_opt_out = b.activities_opt_out === true || b.activities_opt_out === 'true';
      if (b.whatsapp_opt_in !== undefined)
        updates.whatsapp_opt_in = b.whatsapp_opt_in === true || b.whatsapp_opt_in === 'true';
      if (b.activities_opt_out !== undefined)
        updates.activities_opt_out = b.activities_opt_out === true || b.activities_opt_out === 'true';

      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'nothing to update' });

      const setSql = Object.keys(updates)
        .map((k, i) => `${k} = $${i + 1}`)
        .join(', ');
      const rows = await query(
        `UPDATE guests SET ${setSql} WHERE id = $${Object.keys(updates).length + 1} RETURNING *`,
        [...Object.values(updates), id]
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/overview', async (_req, res, next) => {
    try {
      const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
      const [arrivals, departures, inHouse, stats] = await Promise.all([
        query(
          `SELECT id, name, phone, room, journey_state FROM guests
           WHERE check_in = ${TODAY} AND journey_state IN ('booked','pre_arrival')
           ORDER BY name`
        ),
        query(
          `SELECT id, name, phone, room, journey_state FROM guests
           WHERE check_out = ${TODAY} AND journey_state IN ('checked_in','in_stay','checkout_pending')
           ORDER BY name`
        ),
        query(
          `SELECT id, name, phone, room, journey_state FROM guests
           WHERE journey_state IN ('checked_in','in_stay','checkout_pending')
           ORDER BY name`
        ),
        query(
          `SELECT
             (SELECT count(*) FROM messages WHERE direction='out'
                AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY})::int AS sent_today,
             (SELECT count(*) FROM messages WHERE direction='in'
                AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY})::int AS received_today,
             (SELECT count(*) FROM activities WHERE date = ${TODAY})::int AS activities_today`
        ),
      ]);
      res.json({ arrivals, departures, inHouse, stats: stats[0] });
    } catch (err) {
      next(err);
    }
  });

  // Staff-driven journey events — same state machine, same policy, same audit
  // trail as the PMS webhooks. One code path.
  async function guestEvent(id, eventName, detail) {
    const guests = await query(
      `SELECT id, phone, name, property, room, to_char(check_in,'YYYY-MM-DD') AS check_in,
              to_char(check_out,'YYYY-MM-DD') AS check_out, journey_state, ai_paused, activities_opt_out, created_at
       FROM guests WHERE id = $1`,
      [id]
    );
    if (guests.length === 0) return { status: 404, body: { error: 'guest not found' } };
    const result = await applyEventToGuest(guests[0], eventName, detail);
    return { status: 200, body: { guestId: guests[0].id, ...result } };
  }

  router.post('/api/guests/:id/checkin', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const r = await guestEvent(id, 'checked_in', 'dashboard check-in');
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/guests/:id/checkout', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const r = await guestEvent(id, 'checked_out', 'dashboard checkout');
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Manual staff reply to a guest — free text, within the 24h session window.
  router.post('/api/guests/:id/messages', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const content = String(req.body?.content ?? '').trim();
      if (!content) return res.status(400).json({ error: 'message text is required' });
      if (content.length > 1000) return res.status(400).json({ error: 'message too long (max 1000 chars)' });
      const guests = await query('SELECT id FROM guests WHERE id = $1', [id]);
      if (guests.length === 0) return res.status(404).json({ error: 'guest not found' });
      const msg = await queueMessage({
        guestId: id,
        content,
        messageType: 'free_text',
        triggerReason: 'staff_manual',
      });
      await dispatchPending();
      res.status(201).json(msg ?? { note: 'already queued' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Retry a failed message: back to queued, dispatcher picks it up.
  router.post('/api/messages/:id/retry', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const rows = await query(
        `UPDATE messages SET status = 'queued', retry_count = 0
         WHERE id = $1 AND status = 'failed'
         RETURNING id`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'message not found or not failed' });
      await dispatchPending();
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/activities', async (_req, res, next) => {
    try {
      res.json(await listActivities());
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/activities', async (req, res) => {
    try {
      const result = await createAndBroadcastActivity(req.body ?? {});
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
