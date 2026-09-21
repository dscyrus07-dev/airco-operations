import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { verifySignature } from './src/whatsapp/signature.js';
import { handleVerification, handleEvent } from './src/whatsapp/webhook.js';
import { handleTwilioEvent, verifyTwilioSignature } from './src/whatsapp/twilio-webhook.js';
import { adminRouter } from './src/admin/routes.js';
import {
  handleBookingWebhook,
  applyEventToGuest,
  runDateTick,
  findGuestByPhone,
} from './src/agent/triggers.js';
import { dispatchPending } from './src/messaging/outbound.js';
import { query, closePool } from './src/db.js';

const config = loadConfig();
const app = express();

app.set('trust proxy', true); // behind Railway proxy — correct req.protocol/hostname for Twilio signatures

app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const hits = new Map();
function rateLimit({ max = 100, windowMs = 60_000 } = {}) {
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

app.get('/webhook', (req, res) => {
  const result = handleVerification(req.query, config.whatsappVerifyToken);
  res.status(result.status).send(result.body);
});

app.post('/webhook', rateLimit(), (req, res) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'], config.whatsappAppSecret)) {
    console.warn('[webhook] rejected POST: invalid X-Hub-Signature-256');
    return res.status(401).json({ error: 'invalid signature' });
  }
  handleEvent(req.body).catch((err) => console.error('[webhook] processing error:', err));
  res.status(200).json({ received: true });
});

// Twilio WhatsApp inbound + status callbacks (form-encoded)
app.post('/webhook/twilio', express.urlencoded({ extended: false, limit: '1mb' }), rateLimit(), (req, res) => {
  const params = req.body ?? {};
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const authToken = config.twilioAuthToken;
  if (authToken && !verifyTwilioSignature(authToken, signature, url, params)) {
    console.warn('[twilio] rejected POST: invalid X-Twilio-Signature');
    return res.status(401).json({ error: 'invalid signature' });
  }
  handleTwilioEvent(params).catch((err) => console.error('[twilio] processing error:', err));
  res.status(200).type('text/xml').send('<Response/>');
});

app.post('/webhooks/booking', rateLimit(), async (req, res) => {
  if (req.headers['x-webhook-secret'] !== config.bookingWebhookSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const guest = await handleBookingWebhook(req.body);
    const result = await applyEventToGuest(guest, 'booking_created', 'booking webhook');
    res.json({ guestId: guest.id, ...result });
  } catch (err) {
    console.error('[booking] error:', err);
    res.status(400).json({ error: err.message });
  }
});

async function requireGuest(req, res) {
  if (req.headers['x-webhook-secret'] !== config.bookingWebhookSecret) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  const guest = await findGuestByPhone(req.body?.phone ?? '');
  if (!guest) {
    res.status(404).json({ error: 'guest not found' });
    return null;
  }
  return guest;
}

app.post('/webhooks/checkin', rateLimit(), async (req, res) => {
  try {
    const guest = await requireGuest(req, res);
    if (!guest) return;
    const result = await applyEventToGuest(guest, 'checked_in', 'check-in webhook');
    res.json({ guestId: guest.id, ...result });
  } catch (err) {
    console.error('[checkin] error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/webhooks/checkout', rateLimit(), async (req, res) => {
  try {
    const guest = await requireGuest(req, res);
    if (!guest) return;
    const result = await applyEventToGuest(guest, 'checked_out', 'checkout webhook');
    res.json({ guestId: guest.id, ...result });
  } catch (err) {
    console.error('[checkout] error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: 'up', property: config.property });
  } catch {
    res.status(500).json({ ok: false, db: 'down' });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/', (_req, res) => res.redirect('/admin'));
app.use('/admin', adminRouter());
app.use(express.static(path.join(__dirname, 'public')));

const TICK_INTERVAL_MS = 15 * 60_000;
setInterval(() => {
  runDateTick(new Date()).catch((err) => console.error('[tick] error:', err));
  dispatchPending().catch((err) => console.error('[dispatch] error:', err));
}, TICK_INTERVAL_MS).unref();

runDateTick(new Date()).catch((err) => console.error('[tick] boot error:', err));
dispatchPending().catch((err) => console.error('[dispatch] boot error:', err));

app.listen(config.port, () => {
  console.log(`airco-agent listening on :${config.port} (property: ${config.property})`);
});

process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closePool();
  process.exit(0);
});
// Reliability: a stray rejection must never kill the agent silently.
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  closePool()
    .catch(() => {})
    .finally(() => process.exit(1)); // supervisor (PM2) restarts us
});
