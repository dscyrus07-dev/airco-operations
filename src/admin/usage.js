// Twilio WhatsApp usage/health for the admin Usage page.
// Hybrid view: message counters come from OUR database (every send/inbound is
// already recorded with direction + status + timestamp); Twilio REST provides
// account balance and connection health. Credentials stay server-side.
import { query } from '../db.js';
import { getConfig } from '../config.js';

const CACHE_TTL_MS = 60_000;
let cache = { at: 0, data: null };

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
export function usageThresholds() {
  return {
    low: envNum('USAGE_LOW_BALANCE_USD', 10),
    critical: envNum('USAGE_CRITICAL_BALANCE_USD', 3),
  };
}
function estCostPerMsg() {
  return envNum('USAGE_EST_COST_PER_MSG_USD', 0.0065);
}

async function twilioBalance() {
  const cfg = getConfig();
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Balance.json`,
    {
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString('base64'),
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio balance HTTP ${res.status}`);
  return { amount: parseFloat(body.balance), currency: body.currency || 'USD' };
}


// Reconcile our message statuses from Twilio — fixes rows stuck at 'sent'
// when a status callback was missed. Only upgrades status, never downgrades.
function authHeader() {
  const cfg = getConfig();
  return 'Basic ' + Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString('base64');
}

async function reconcileStatuses() {
  const cfg = getConfig();
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Messages.json?PageSize=50`,
    { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(8000) }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return 0;
  const oursFor = { delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };
  let updated = 0;
  for (const m of body.messages ?? []) {
    const ours = oursFor[m.status];
    if (!ours) continue;
    const rows = await query(
      `UPDATE messages SET status = $1, last_error = $2, updated_at = now()
       WHERE wa_message_id = $3 AND direction = 'out'
         AND status IN ('queued','sent')
       RETURNING id`,
      [ours, m.status === 'undelivered' ? 'undelivered (Twilio)' : null, m.sid]
    );
    updated += rows.length;
  }
  return updated;
}

async function messageStats() {
  const [todayRows, monthRows, dailyRows, recentRows] = await Promise.all([
    query(
      `SELECT direction, count(*)::int AS n FROM messages
       WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date
       GROUP BY direction`
    ),
    query(
      `SELECT
         count(*) FILTER (WHERE direction = 'out')::int AS sent,
         count(*) FILTER (WHERE direction = 'in')::int AS received,
         count(*) FILTER (WHERE direction = 'out' AND status = 'failed')::int AS failed,
         count(*) FILTER (WHERE direction = 'out' AND status IN ('delivered','read'))::int AS delivered
       FROM messages
       WHERE date_trunc('month', (created_at AT TIME ZONE 'Asia/Kolkata'))
           = date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))`
    ),
    query(
      `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, direction,
              count(*)::int AS n
       FROM messages
       WHERE created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - interval '6 days'
       GROUP BY 1, 2 ORDER BY 1`
    ),
    query(
      `SELECT m.id, m.direction, m.status, m.message_type, m.template_name,
              (m.created_at AT TIME ZONE 'Asia/Kolkata')::time(0) AS time_ist,
              g.name AS guest_name
       FROM messages m LEFT JOIN guests g ON g.id = m.guest_id
       ORDER BY m.id DESC LIMIT 15`
    ),
  ]);

  const today = { out: 0, in: 0 };
  for (const r of todayRows) today[r.direction === 'in' ? 'in' : 'out'] = r.n;
  const month = monthRows[0] ?? { sent: 0, received: 0, failed: 0, delivered: 0 };
  const finalOut = Number(month.delivered) + Number(month.failed);
  const daily = {};
  for (const r of dailyRows) {
    daily[r.day] = daily[r.day] ?? { sent: 0, received: 0 };
    daily[r.day][r.direction === 'out' ? 'sent' : 'received'] += r.n;
  }

  return {
    sentToday: today.out ?? 0,
    receivedToday: today.in ?? 0,
    sentThisMonth: Number(month.sent ?? 0),
    receivedThisMonth: Number(month.received ?? 0),
    failedThisMonth: Number(month.failed ?? 0),
    deliveredThisMonth: Number(month.delivered ?? 0),
    deliveryRate:
      Number(month.delivered) + Number(month.failed) > 0
        ? Math.round((Number(month.delivered) / (Number(month.delivered) + Number(month.failed))) * 1000) / 10
        : null,
    daily,
    recent: recentRows,
  };
}

export async function getUsage({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }
  const [balanceRes, stats, reconciled] = await Promise.all([
    twilioBalance().catch(() => ({ ok: false, error: 'Twilio unreachable' })),
    (async () => { if (force) await reconcileStatuses(); return messageStats(); })(),
  ]);
  const cfg = getConfig();
  const thresholds = { low: usageLowThreshold(), critical: usageCriticalThreshold() };
  const cost = estCostPerMsg();

  // Projections from the last-7-day average — real data, no invented numbers.
  const days = Object.values(stats.daily ?? {});
  const avgDailySends = days.length
    ? Math.round((days.reduce((s, d) => s + d.sent, 0) / days.length) * 10) / 10
    : 0;
  const dailyCostUsd = Math.round(avgDailySends * cost * 10000) / 10000;
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const daysInMonth = new Date(nowIst.getUTCFullYear(), nowIst.getUTCMonth() + 1, 0).getUTCDate();
  const dayOfMonth = nowIst.getUTCDate();
  const projectedMonthCostUsd = Math.round(dailyCostUsd * daysInMonth * 100) / 100;
  const runwayDays = dailyCostUsd > 0
    ? Math.floor(balanceRes.amount / dailyCostUsd)
    : null;

  const data = {
    balance: balanceRes.error
      ? { error: balanceRes.error }
      : {
          amount: balanceRes.amount,
          currency: balanceRes.currency,
          health:
            balanceRes.amount <= thresholds.critical ? 'critical'
            : balanceRes.amount <= thresholds.low ? 'low'
            : 'healthy',
        },
    messages: stats,
    sender: { number: cfg.twilioWhatsappFrom, connected: !balanceRes.error },
    capacity:
      !balanceRes.error && cost
        ? {
            messages: Math.floor(balanceRes.amount / cost),
            perMessageCost: cost,
            currency: balanceRes.currency,
          }
        : { unavailable: true },
    projections: {
      avgDailySends,
      dailyCostUsd,
      projectedMonthCostUsd,
      runwayDays,
      dayOfMonth,
      daysInMonth,
    },
    limits: {
      proactiveDailyCap: cfg.proactiveDailyCap,
      tier: 'Auto-scaling — 250 → 1K → 10K → 100K → unlimited',
    },
    thresholds,
    syncedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

function usageLowThreshold() {
  return envNum('USAGE_LOW_BALANCE_USD', 10);
}
function usageCriticalThreshold() {
  return envNum('USAGE_CRITICAL_BALANCE_USD', 3);
}

export function invalidateUsageCache() {
  cache = { at: 0, data: null };
}
