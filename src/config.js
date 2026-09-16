import 'dotenv/config';

const REQUIRED = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_WABA_ID',
  'DATABASE_URL',
  'BOOKING_WEBHOOK_SECRET',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Fill them in .env (see .env.example).`
    );
  }
  return {
    whatsappAccessToken: String(env.WHATSAPP_ACCESS_TOKEN).trim(),
    whatsappPhoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID).trim(),
    whatsappAppSecret: String(env.WHATSAPP_APP_SECRET).trim(),
    whatsappVerifyToken: String(env.WHATSAPP_VERIFY_TOKEN).trim(),
    whatsappWabaId: String(env.WHATSAPP_WABA_ID).trim(),
    bookingWebhookSecret: String(env.BOOKING_WEBHOOK_SECRET).trim(),
    adminToken: String(env.ADMIN_TOKEN || '').trim(),
    databaseUrl: String(env.DATABASE_URL).trim(),
    graphApiVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    port: Number(env.PORT || 3000),
    timezone: 'Asia/Kolkata',
    property: 'Zostel Mumbai',
    proactiveDailyCap: Number(env.PROACTIVE_DAILY_CAP || 2),
    testRecipientNumber: String(env.TEST_RECIPIENT_NUMBER || '').trim(),
  };
}

let cached = null;

export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}
