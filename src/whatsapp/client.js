const TIMEOUT_MS = 10_000;

export function isRetryableError(err) {
  if (err && typeof err.status === 'number') {
    return err.status === 429 || err.status >= 500;
  }
  return true;
}

export function activeProvider() {
  return (process.env.WHATSAPP_PROVIDER || 'meta').trim().toLowerCase();
}

// ---------- Meta Cloud API ----------

async function postMetaMessages(payload) {
  if (process.env.WHATSAPP_DRY_RUN === 'true') {
    console.error('[whatsapp] DRY RUN — no real message sent:', JSON.stringify(payload));
    return { messages: [{ id: `dryrun_${Date.now()}` }] };
  }
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Graph API ${res.status}: ${JSON.stringify(body)}`);
      err.status = res.status;
      err.graphBody = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMetaText(to, text) {
  const res = await postMetaMessages({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
  return { waMessageId: res?.messages?.[0]?.id ?? null };
}

async function sendMetaTemplate(to, name, language = 'en', components = []) {
  const res = await postMetaMessages({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name, language: { code: language }, components },
  });
  return { waMessageId: res?.messages?.[0]?.id ?? null };
}

// ---------- Twilio ----------

function twilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886
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
      body: new URLSearchParams(payload).toString(),
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

async function sendTwilioText(to, text) {
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
// TWILIO_CONTENT_SIDS (JSON). Without a mapping (sandbox), send the rendered
// body as free text so journeys keep working.
async function sendTwilioTemplate(to, name, _language, components = []) {
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
    return sendTwilioText(to, renderTemplateBody(name, vars));
  }
  const variables = Object.fromEntries(vars.map((v, i) => [String(i + 1), v]));
  const { sid, authToken, from } = twilioConfig();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: from,
      To: `whatsapp:+${to}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(Object.fromEntries(vars.map((v, i) => [String(i + 1), v]))),
      ...(process.env.TWILIO_STATUS_CALLBACK
        ? { StatusCallback: process.env.TWILIO_STATUS_CALLBACK }
        : {}),
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Twilio API ${res.status}: ${JSON.stringify(body)}`);
    err.status = res.status;
    throw err;
  }
  return { waMessageId: body.sid };
}

// ---------- Public provider-agnostic API ----------

export async function sendText(to, text) {
  if (activeProvider() === 'twilio') return sendTwilioText(to, text);
  return sendMetaText(to, text);
}

export async function sendTemplate(to, name, language = 'en', components = []) {
  if (activeProvider() === 'twilio') return sendTwilioTemplate(to, name, language, components);
  return sendMetaTemplate(to, name, language, components);
}
