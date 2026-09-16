const TIMEOUT_MS = 10_000;

export function isRetryableError(err) {
  if (err && typeof err.status === 'number') {
    return err.status === 429 || err.status >= 500;
  }
  return true;
}

async function postMessages(payload) {
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

export async function sendText(to, text) {
  const res = await postMessages({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
  return { waMessageId: res?.messages?.[0]?.id ?? null };
}

export async function sendTemplate(to, name, language = 'en', components = []) {
  const res = await postMessages({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name, language: { code: language }, components },
  });
  return { waMessageId: res?.messages?.[0]?.id ?? null };
}
