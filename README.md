# Airco Agent — WhatsApp Guest Experience System (Zostel Mumbai)

One WhatsApp number, one continuous guest conversation, driven by a deterministic
journey state machine. Postgres is the only source of truth.

## Setup

```
cd airco-agent
docker compose up -d          # local Postgres on :5432
npm install
copy .env.example .env        # fill in real values (see below)
npm run migrate
npm start                     # listens on :3100 (3000 is used by your other project)
```

## Environment (.env)

| Variable | Notes |
|---|---|
| TWILIO_ACCOUNT_SID | Twilio Console → Account Info |
| TWILIO_AUTH_TOKEN | Twilio Console → Auth Token |
| TWILIO_WHATSAPP_FROM | WhatsApp sender, e.g. whatsapp:+14155238886 |
| TWILIO_STATUS_CALLBACK | Public URL for delivery statuses (/webhook) |
| TWILIO_CONTENT_SIDS | Map of journey template name → approved ContentSid (HX...) |
| DATABASE_URL | Local default matches docker-compose.yml |
| BOOKING_WEBHOOK_SECRET | Shared secret for the stubbed PMS webhooks |
| TEST_RECIPIENT_NUMBER | Your test phone, digits only (e.g. 919876543210) |
| REVIEW_URL | Google review link used in the review_request template |

## Meta configuration (one-time)

1. Webhook: Callback URL `https://<your-tunnel>/webhook`, Verify Token = value from
   .env. Subscribe to the `messages` field.
2. Templates: create the 4 utility templates in Meta Business Manager with the exact
   names and bodies from `src/templates/definitions.js` (language: en). Sends are
   blocked until Meta approves them.

## Verification

- `npm test` — unit tests (journey, policy, signature). No DB needed.
- `npm run demo` — full Phase 1 flow locally in dry-run mode (no real WhatsApp
  sends): booking → pre-arrival → check-in → checkout reminder → checkout → review
  request. Asserts all 4 messages fire in order.
- `npm run simulate -- booking|checkin|checkout --phone ...` — fire the stubbed
  webhooks against a running server.

## Endpoints

- `GET /webhook` — Meta verification challenge
- `POST /webhook` — Meta events (signature-verified)
- `POST /webhooks/booking|checkin|checkout` — stubbed PMS (x-webhook-secret)
- `GET /health` — liveness + DB check
