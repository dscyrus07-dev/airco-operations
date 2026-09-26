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
import {
  createAndBroadcastActivity,
  listActivities,
  updateActivity,
  deleteActivity,
  broadcastActivityById,
  getActivity,
} from '../agent/activities.js';
import { getUsage } from './usage.js';
import { importBulkReport, sendManualTemplate } from '../agent/bulk-import.js';
import {
  getAllTemplateConfigs,
  setTemplateBody,
  setTemplateContentSid,
  getReviewUrl,
  setReviewUrl,
  validateTemplateBody,
  buildTemplateExamples,
  TEMPLATE_NAMES,
} from '../templates/store.js';
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
        `SELECT g.id::int AS id, g.phone, g.name, g.room,
                to_char(g.check_in, 'YYYY-MM-DD') AS check_in,
                to_char(g.check_out, 'YYYY-MM-DD') AS check_out,
                g.journey_state, g.ai_paused, g.whatsapp_opt_in, g.created_at,
                (SELECT count(*) FROM messages m
                  WHERE m.guest_id = g.id AND m.direction = 'out' AND m.message_type = 'template'
                    AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date
                      = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS proactive_today,
                (SELECT count(*) FROM messages mw
                  WHERE mw.guest_id = g.id AND mw.template_name = 'welcome'
                    AND mw.status IN ('queued','sent','delivered','read'))::int AS welcome_sent,
                (SELECT count(*) FROM messages mr WHERE mr.guest_id = g.id AND mr.template_name = 'review_request'
                    AND mr.status IN ('queued','sent','delivered','read'))::int AS review_sent
         FROM guests g
         WHERE g.archived = FALSE
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
      const [messages, events, requests, bookings] = await Promise.all([
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
        query(
          `SELECT id, reservation_number, pre_arrival_due_at, pre_arrival_sent_at, pre_arrival_status,
                  checkout_reminder_due_at, checkout_reminder_sent_at, checkout_reminder_status
           FROM bookings WHERE guest_id = $1 ORDER BY id DESC LIMIT 5`,
          [id]
        ),
      ]);
      res.json({ guest: guests[0], messages, events, requests, bookings: bookings.rows });
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
      const existing = await query('SELECT id::int AS id, phone, name, property, room, check_in, check_out, journey_state, ai_paused, whatsapp_opt_in, activities_opt_out FROM guests WHERE id = $1', [id]);
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

  // Soft-delete (archive): removes the guest from the operations dashboard
  // while preserving every message, journey event and audit row.
  router.delete('/api/guests/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const rows = await query(
        `UPDATE guests SET archived = TRUE WHERE id = $1 AND archived = FALSE RETURNING id, name`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'guest not found' });
      res.json({ ok: true, id: rows[0].id, name: rows[0].name });
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
        `UPDATE messages SET status = 'queued', retry_count = 0, next_attempt_at = now()
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

  router.patch('/api/activities/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const updated = await updateActivity(id, req.body ?? {});
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/activities/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      res.json(await deleteActivity(id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Send (or re-send to new in-house guests) a stored draft/scheduled activity.
  router.post('/api/activities/:id/send', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const result = await broadcastActivityById(id);
      res.json({ activityId: id, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/activities/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      const activity = await getActivity(id);
      if (!activity) return res.status(404).json({ error: 'activity not found' });
      res.json(activity);
    } catch (err) {
      next(err);
    }
  });

  // Twilio WhatsApp usage/health — balance via Twilio REST (server-side only),
  // message counters from our own database. Cached 60s; ?refresh=1 forces fresh.
  router.get('/api/usage', async (req, res, next) => {
    try {
      const force = req.query.refresh === '1';
      res.json(await getUsage({ force }));
    } catch (err) {
      res.status(502).json({ error: 'Twilio usage temporarily unavailable', detail: err.message });
    }
  });

  // ---- Journey template management (dashboard-editable) ----

  router.get('/api/templates', async (_req, res, next) => {
    try {
      const configs = await getAllTemplateConfigs();
      const reviewUrl = await getReviewUrl();
      // approval status per template from Twilio (best-effort)
      const withStatus = await Promise.all(configs.map(async (t) => {
        let approval = 'unknown';
        if (t.contentSid) {
          try {
            const auth = 'Basic ' + Buffer.from(
              `${getConfig().twilioAccountSid}:${getConfig().twilioAuthToken}`
            ).toString('base64');
            const r = await fetch(
              `https://content.twilio.com/v1/Content/${t.contentSid}/ApprovalRequests`,
              { headers: { Authorization: auth }, signal: AbortSignal.timeout(8000) }
            );
            const j = await r.json().catch(() => ({}));
            approval = j.whatsapp?.status ?? 'not submitted';
          } catch { approval = 'unreachable'; }
        } else approval = 'no content';
        return { ...t, approval };
      }));
      res.json({ templates: withStatus, reviewUrl });
    } catch (err) {
      next(err);
    }
  });

  // Edit a template: saves copy to DB, creates a new Twilio Content resource
  // with the same example values, re-submits for approval, and switches the
  // active ContentSid. The previously approved version keeps delivering until
  // the new one clears review.
  router.put('/api/templates/:name', async (req, res) => {
    try {
      const name = String(req.params.name);
      if (!TEMPLATE_NAMES.includes(name)) return res.status(400).json({ error: 'unknown template' });
      const body = String(req.body?.body ?? '').trim();
      // Meta rule: variables can't be at the very start or end of the body
      const bodyError = validateTemplateBody(body);
      if (bodyError) return res.status(400).json({ error: bodyError });

      if (req.body?.reviewUrl !== undefined && name === 'review_request') {
        await setReviewUrl(String(req.body.reviewUrl ?? '').trim());
      }
      await setTemplateBody(name, body);

      // Build the new Twilio Content with the same example values as before.
      const auth = 'Basic ' + Buffer.from(
        `${getConfig().twilioAccountSid}:${getConfig().twilioAuthToken}`
      ).toString('base64');
      const configs = await getAllTemplateConfigs();
      const current = configs.find((t) => t.name === name);
      let examples = { 1: 'Cyrus' };
      if (current?.contentSid) {
        const r = await fetch(`https://content.twilio.com/v1/Content/${current.contentSid}`, {
          headers: { Authorization: auth }, signal: AbortSignal.timeout(8000),
        });
        const j = await r.json().catch(() => ({}));
        if (j.variables && Object.keys(j.variables).length) examples = j.variables;
      }
      const varCount = (body.match(/\{\{\d+\}\}/g) ?? []).length;
      // FIX 8 follow-up: fill example gaps when an edit ADDS variables —
      // Meta rejects submissions where any variable lacks an example.
      const trimmedExamples = buildTemplateExamples(examples, varCount);

      const createRes = await fetch('https://content.twilio.com/v1/Content', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friendly_name: `airco_${name}_${Date.now().toString(36)}`,
          language: 'en',
          variables: trimmedExamples,
          types: { 'twilio/text': { body } },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const created = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        return res.status(502).json({ error: 'Twilio content creation failed', detail: created.message ?? '' });
      }

      const subRes = await fetch(
        `https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`,
        {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          // Versioned name: Meta rejects duplicate template names, and the
          // previously approved version still holds the base name.
          body: JSON.stringify({ name: `${name}_v${Date.now().toString(36)}`, category: 'UTILITY' }),
          signal: AbortSignal.timeout(10000),
        }
      );
      const sub = await subRes.json().catch(() => ({}));

      const oldSid = current?.contentSid;
      await setTemplateContentSid(name, created.sid);
      if (oldSid && oldSid !== created.sid) {
        fetch(`https://content.twilio.com/v1/Content/${oldSid}`, {
          method: 'DELETE', headers: { Authorization: auth }, signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }

      res.json({
        ok: true,
        name,
        contentSid: created.sid,
        approval: sub.whatsapp?.status ?? sub.body?.whatsapp?.status ?? 'received',
        note: 'Saved. Re-submitted for WhatsApp approval — the previous approved version keeps delivering until this one clears.',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Bulk import: Zostel operational report ----

  // Preview (execute=false) or execute. Body: { text, execute }
  router.post('/api/import/bookings', async (req, res) => {
    try {
      const text = String(req.body?.text ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'paste the report first' });
      const execute = req.body?.execute === true;
      const result = await importBulkReport(text, {
        uploadedBy: 'dashboard',
        execute,
      });
      if (execute) await dispatchPending();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bulk welcome: manually send the approved welcome template to selected
  // checked-in guests. Idempotent — already-sent guests are reported, not resent.
  router.post('/api/guests/send-welcome', async (req, res) => {
    try {
      const ids = (req.body?.ids ?? []).map(Number).filter(Number.isInteger);
      if (!ids.length) return res.status(400).json({ error: 'no guests selected' });
      const { sendManualTemplate } = await import('../agent/bulk-import.js');
      const result = await sendManualTemplate(ids, 'welcome');
      await dispatchPending();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bulk review request: manually send to selected checked-out guests.
  router.post('/api/guests/send-review', async (req, res) => {
    try {
      const ids = (req.body?.ids ?? []).map(Number).filter(Number.isInteger);
      if (!ids.length) return res.status(400).json({ error: 'no guests selected' });
      const { sendManualTemplate } = await import('../agent/bulk-import.js');
      const result = await sendManualTemplate(ids, 'review_request');
      await dispatchPending();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bulk delete (archive): staff-selected guests stop all messaging.
  router.post('/api/guests/bulk-delete', async (req, res, next) => {
    try {
      const ids = (req.body?.ids ?? []).map(Number).filter(Number.isInteger);
      if (!ids.length) return res.status(400).json({ error: 'no guests selected' });
      const rows = await query(
        `UPDATE guests SET archived = TRUE WHERE id = ANY($1) AND archived = FALSE RETURNING id, name`,
        [ids]
      );
      res.json({ deleted: rows.length, names: rows.map((r) => r.name) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
