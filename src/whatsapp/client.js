// Twilio WhatsApp transport — the single outbound channel for the Airco Agent.
// Free-text sends use the Messages API; journey templates use Twilio Content
// templates addressed by ContentSid (HX...) with ContentVariables.
const TIMEOUT_MS = 10_000;

export function isRetryableError(err) {
  if (err && typeof err.status === 'number') {
    return err.status === 429 || err.status >= 500;
  }
  return true;
}

// FIX 3: reconcile a claimed-but-unconfirmed send by asking Twilio for the
// message's actual status. Returns our canonical status or null.
export async function fetchMessageStatus(messageSid) {
  if (process.env.WHATSAPP_DRY_RUN === 'true') return null;
  const { sid, authToken } = twilioConfig();
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${encodeURIComponent(messageSid)}.json`,
    {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${authToken}`).toString('base64') },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const map = {
    accepted: 'sent', queued: 'queued', scheduled: 'queued', sent: 'sent',
    delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed',
  };
  return map[body.status] ?? null;
}

function twilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+17372508034
  if (!sid || !authToken || !from) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM not configured');
  }
  return { sid, authToken, from };
}

async function postTwilioMessages(params) {
  if (process.env.WHATSAPP_DRY_RUN === 'true') {
    console.error('[whatsapp] DRY RUN — no real message sent:', JSON.stringify(params));
    return { sid: `dryrun_${Date.now()}` };
  }
  const { sid, authToken } = twilioConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Twilio API ${res.status}: ${JSON.stringify(body)}`);
      err.status = res.status;
      err.twilioBody = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendText(to, text) {
  const { from } = twilioConfig();
  const body = await postTwilioMessages({
    From: from,
    To: `whatsapp:+${to}`,
    Body: text,
    ...(process.env.TWILIO_STATUS_CALLBACK
      ? { StatusCallback: process.env.TWILIO_STATUS_CALLBACK }
      : {}),
  });
  return { waMessageId: body.sid ?? null };
}

// Twilio Content API templates are addressed by ContentSid (HX...) with
// ContentVariables {"1":"..","2":".."}. Map internal template names via
// TWILIO_CONTENT_SIDS (JSON). Without a mapping the rendered body is sent as
// free text (allowed inside an open 24h session with a registered sender).
export async function sendTemplate(to, name, _language, components = []) {
  // Template config (ContentSid + fallback copy) lives in the database —
  // editable from the dashboard without code deploys.
  const { getTemplateConfig } = await import('../templates/store.js');
  const cfgRow = (await getTemplateConfig(name)) ?? {};
  const contentSid = cfgRow.contentSid ?? null;
  const vars = (components?.[0]?.parameters ?? []).map((p) => String(p?.text ?? ''));

  const freeformFallback = () => {
    if (process.env.TWILIO_ALLOW_FREEFORM_FALLBACK !== 'true') return false;
    console.warn(`[twilio] template ${name} unavailable — falling back to rendered free text`);
    return true;
  };

  const sendFreeform = async () => {
    const { renderTemplateBody } = await import('../templates/definitions.js');
    return sendText(to, renderTemplateBody(name, vars));
  };

  if (!contentSid) {
    if (!freeformFallback()) {
      throw new Error(`Twilio: no approved ContentSid for template ${name}; refusing free-text fallback`);
    }
    return sendFreeform();
  }

  try {
    const body = await postTwilioMessages({
      From: twilioConfig().from,
      To: `whatsapp:+${to}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(Object.fromEntries(vars.map((v, i) => [String(i + 1), v]))),
      ...(process.env.TWILIO_STATUS_CALLBACK
        ? { StatusCallback: process.env.TWILIO_STATUS_CALLBACK }
        : {}),
    });
    return { waMessageId: body.sid };
  } catch (err) {
    // 63016 = template not approved / outside window — fall back to the
    // rendered Zostel copy as free text while approvals are in flight.
    if (err?.twilioBody?.code === 63016 && freeformFallback()) {
      return sendFreeform();
    }
    throw err;
  }
}
