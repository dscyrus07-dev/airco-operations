import 'dotenv/config';

const REQUIRED_ALWAYS = ['DATABASE_URL', 'BOOKING_WEBHOOK_SECRET'];

const REQUIRED_META = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_WABA_ID',
];

const REQUIRED_TWILIO = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'];

export function loadConfig(env = process.env) {
  const provider = String(env.WHATSAPP_PROVIDER || 'meta').trim().toLowerCase();
  const required = [...REQUIRED_ALWAYS, ...(provider === 'twilio' ? REQUIRED_TWILIO : REQUIRED_META)];
  const missing = required.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Fill them in .env (see .env.example).`
    );
  }
  return {
    whatsappProvider: provider,
    whatsappAccessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    whatsappPhoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    whatsappAppSecret: String(env.WHATSAPP_APP_SECRET || '').trim(),
    whatsappVerifyToken: String(env.WHATSAPP_VERIFY_TOKEN || '').trim(),
    whatsappWabaId: String(env.WHATSAPP_WABA_ID || '').trim(),
    twilioAccountSid: String(env.TWILIO_ACCOUNT_SID || '').trim(),
    twilioAuthToken: String(env.TWILIO_AUTH_TOKEN || '').trim(),
    twilioWhatsappFrom: String(env.TWILIO_WHATSAPP_FROM || '').trim(),
    bookingWebhookSecret: String(env.BOOKING_WEBHOOK_SECRET).trim(),
    adminToken: String(env.ADMIN_TOKEN || '').trim(),
    databaseUrl: String(env.DATABASE_URL).trim(),
    graphApiVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    port: Number(env.PORT || 3000),
    timezone: 'Asia/Kolkata',
    property: 'Zostel Mumbai',
    proactiveDailyCap: Number(env.PROACTIVE_DAILY_CAP || 2),
    // Scheduled send times (Asia/Kolkata). Configurable, not hardcoded in logic.
    preArrivalSendHour: Number(env.PRE_ARRIVAL_SEND_HOUR ?? 10),
    welcomeSendHour: Number(env.WELCOME_SEND_HOUR ?? 10),
    checkoutReminderSendHour: Number(env.CHECKOUT_REMINDER_SEND_HOUR ?? 9),
    testRecipientNumber: String(env.TEST_RECIPIENT_NUMBER || '').trim(),
  };
}

let cached = null;

export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}
