import 'dotenv/config';

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
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
    twilioAccountSid: String(env.TWILIO_ACCOUNT_SID).trim(),
    twilioAuthToken: String(env.TWILIO_AUTH_TOKEN).trim(),
    twilioWhatsappFrom: String(env.TWILIO_WHATSAPP_FROM).trim(),
    bookingWebhookSecret: String(env.BOOKING_WEBHOOK_SECRET).trim(),
    adminToken: String(env.ADMIN_TOKEN || '').trim(),
    databaseUrl: String(env.DATABASE_URL).trim(),
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
