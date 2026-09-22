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
  let contentSid = null;
  const raw = process.env.TWILIO_CONTENT_SIDS;
  if (raw) {
    try {
      contentSid = JSON.parse(raw)[name] ?? null;
    } catch {
      console.warn('[twilio] TWILIO_CONTENT_SIDS set but not valid JSON — ignoring');
    }
  }
  const vars = (components?.[0]?.parameters ?? []).map((p) => String(p?.text ?? ''));

  if (!contentSid) {
    if (process.env.NODE_ENV === 'production' && process.env.TWILIO_ALLOW_FREEFORM_FALLBACK !== 'true') {
      throw new Error(`Twilio: no approved ContentSid for template ${name}; refusing free-text fallback`);
    }
    console.warn(`[twilio] no ContentSid for template ${name} — sending rendered body as free text`);
    const { renderTemplateBody } = await import('../templates/definitions.js');
    return sendText(to, renderTemplateBody(name, vars));
  }

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
}
