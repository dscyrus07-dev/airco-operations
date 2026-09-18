# MEMORY.md — Airco Agent

Read this at the start of every session before touching code.

Project: WhatsApp Guest Experience System ("Airco Agent", previously "Erco Agent" —
user renamed via airco-agent-devin-brief.md). Pilot property: Zostel Mumbai only.
Node.js + Express + local Postgres (Docker). No LLM in Phase 1.

## 2026-09-15 — Milestone + Phase 1 scaffold
- What changed: Full scaffold under `airco-agent/`. Postgres schema (001_init.sql:
  guests, messages, templates, requests, activities, journey_events, schema_migrations),
  WhatsApp Cloud API client with 10s timeout + retry classification, X-Hub-Signature-256
  verification (fail closed), Meta webhook routes (GET verify / POST events), booking /
  check-in / checkout webhook stubs (secret-protected), journey state machine (pure),
  deterministic policy engine, outbound queue→send→status pipeline with exponential
  backoff (max 5 attempts), 4 fixed utility templates, scripts (migrate, send-test,
  simulate, demo), unit tests (journey/policy/signature).
- Why: Implements Milestone + Phase 1 of the brief with zero LLM involvement.
- Assumptions made:
  - Proactive cap = 2/day (brief allowed 1–2).
  - All date logic in Asia/Kolkata. Checkout reminder fires on the IST day before
    check_out. in_stay_tick fires same-day once checked in (check_in <= today).
  - Phones stored digits-only E.164 (matches Meta wa_id).
  - Booking webhooks idempotent via unique (guest_id, template_name) partial index —
    each journey template can only ever be sent once per guest per stay.
  - review_requested state is set by the outbound pipeline after review_request
    template send succeeds (only from checked_out).
- Additions beyond the brief's data model (justified by brief principle 5 + send logic):
  messages.wa_message_id (status webhook matching + dedupe), messages.trigger_reason /
  retry_count / last_error (audit + retry), messages.template_components (template vars),
  journey_events table (append-only transition audit).
- What's stubbed / not done:
  - BLOCKER 2026-09-15: WHATSAPP_ACCESS_TOKEN rejected by Graph API
    (190 "could not be decrypted") on debug_token AND phone-number lookup.
    .env copy verified byte-identical to user's paste (202 chars). Token is
    dead at Meta's end — user needs to generate a PERMANENT System User
    token (brief forbids the 24h temporary token anyway).
  - WHATSAPP_APP_SECRET set from user (32-hex, format OK) — real proof only
    when Meta's first signed webhook arrives (tunnel + subscription pending).
  - TEST_RECIPIENT_NUMBER=918855994761 (user gave 8855994761, assumed India +91).
  - 4 templates not yet created/approved in Meta Business Manager — Phase 1 real
    sends blocked until approved.
  - WHATSAPP_DRY_RUN=true env flag in client.js (dev only, logs loudly, never silent)
    used by scripts/demo.js.
  - Phases 2–5 (LLM Q&A, service requests, escalation, activities) not built.
- What this could break / watch for:
  - Template bodies in src/templates/definitions.js must match Meta-approved
    templates exactly (name, language en, variable positions).
  - dispatchPending is single-flight in-process; if the process dies mid-dispatch,
    messages stay 'queued' and are retried on next boot sweep (15-min interval).
  - Status downgrades from Meta are ignored via STATUS_RANK.
- How to test:
  - Unit: `npm test` (no DB needed). VERIFIED 2026-09-15: 20/20 pass.
  - E2E local (dry-run): `docker compose up -d`, `npm run migrate`, `npm run demo`
    — asserts 4 messages in order, ends at review_requested. VERIFIED 2026-09-15: OK.
  - Live server checks: `npm start` then `node scripts/check-webhook.js`
    (signed inbound stored once, redelivery idempotent). VERIFIED 2026-09-15: OK.
  - Failure paths VERIFIED: wrong verify token 403, unsigned webhook POST 401,
    booking webhook without secret 401, bad payload with secret 400.
  - Milestone (real): fill .env creds, `npm run send-test`, reply from test phone,
    confirm inbound row in messages table. NOT DONE — needs real creds.
- Ops notes:
  - Server runs on PORT=3100 — port 3000 is occupied by another local project
    ("X:\\The Airco.ai web" Next.js dev server). Do not kill it.
  - Local Postgres via docker compose (postgres:16, user/pass postgres/postgres,
    db airco_agent). Docker Desktop must be running.

## 2026-09-16 — Real Meta milestone: send + receive VERIFIED end-to-end
- What changed: `.env` now points at the TEST WABA (1075178301891776) and test
  phone number ID (1315636211632125, +1 555-140-6080). Added WHATSAPP_APP_ID
  (1802006677620430). App-level webhook subscription created via Graph API
  (`POST /{app-id}/subscriptions` with app access token, object
  whatsapp_business_account, field messages, callback ngrok URL) plus
  `POST /{waba}/subscribed_apps`. ngrok tunnel `ngrok http 3100` live.
- Verified (real Meta traffic):
  - Outbound: `node scripts/send-test.js` sent real message, Meta returned
    real wa_message_id. Received on test phone 918855994761.
  - Inbound: user replies "Hii" + "Wasup" arrived via webhook POST, passed
    X-Hub-Signature-256 verification, stored in `messages` (rows 7, 8,
    direction=in, real wamids). Guest auto-created (id 3, phone 918855994761,
    name from WhatsApp profile, journey_state=booked).
  - Idempotency: no duplicate wa_message_id rows (unique constraint holds).
- Fixes applied during setup:
  - Test phone needed Cloud API registration: `POST /{phone_id}/register`
    with pin 000000 → success. Was failing with #133010.
  - Recipient had to be added to dev-mode allowed list via dashboard
    (API Setup → To → Manage phone numbers) — NOT possible via API.
    #131030 until added.
  - `/{waba}/subscribed_apps` must be called BEFORE override_callback_uri;
    and the override was unnecessary once app-level /subscriptions was set.
- Still pending:
  - WABA override_callback_uri attempt returned #100 "app must be
    subscribed" — moot since app-level subscription works.
  - Production number +91 88797 31627 still NOT_VERIFIED — needs SMS
    registration when ready (migrates it to API-only).
  - 4 production templates need creation/approval for template sends.
  - App unpublished: real (non-test) inbound may be restricted until
    published. Test WABA traffic works.
- Security: access token + app secret were pasted in chat — rotate them
  after this testing session.
- How to test: `npm start` + `ngrok http 3100`, message the test number
  from the phone, check `messages` table for direction=in rows.

## 2026-09-16 (later) — Full Phase 1 pipeline proven with real template send
- What changed:
  - `scripts/create-templates.js` — creates the 4 templates in Meta from
    src/templates/definitions.js (single source of truth), `--status-only` flag.
  - `scripts/dispatch-now.js` — ops helper to drain the outbound queue immediately.
  - TEST-ONLY `TEMPLATE_OVERRIDES` env (documented in .env.example): remaps a
    template send to a Meta pre-approved test template. Applied in outbound.js
    via templateOverride() in definitions.js. Loud logging. Never in production.
  - outbound.js dispatchPending now also selects guest fields (name, check_in,
    check_out, room) so overrides can interpolate real guest data.
- Verified (real Meta traffic, message id 9):
  - POST /webhooks/booking (secret header) with real guest data → guest 3
    upserted (room 304, 2026-09-18 → 2026-09-20) → journey_events row →
    policy ok → booking_confirmation queued → dispatch → override sent
    jaspers_market_order_confirmation_v1/en_US → Meta wamid → status sent →
    delivery webhook → status delivered. Template received on phone.
  - npm test after changes: 20/20.
- Meta constraints discovered (hard blocks, not bugs):
  - Test WABA (1075178301891776) AUTO-REJECTS all custom template submissions.
    Only its pre-approved en_US templates can be sent: hello_world,
    jaspers_market_* (order_confirmation/image_cta/plain_text/media_carousel).
    Sending a rejected template fails #132001. Approved ones are en_US — the
    send language must match (override carries language).
  - Production WABA (2035908973733316) cannot create templates at all until
    business verification: error_subcode 2494160 "This WABA is not allowed to
    create or update templates."
- Path to production templates (needs user action in Meta, cannot be API'd):
  1. Business verification for Exquisite Hospitality (dashboard).
  2. Then create the 4 templates on production WABA (script ready).
  3. Register +91 88797 31627 on Cloud API (SMS code; number becomes API-only).
  4. Add payment method for business-initiated (template) messages.
- How to re-test the pipeline: ensure TEMPLATE_OVERRIDES set in .env, then
  POST /webhooks/booking with a fresh phone+name (existing guest/template
  pairs are suppressed by the unique constraint — by design).

## 2026-09-16 (evening) — Full-stay walkthrough, all 4 messages delivered
- What happened: walked guest 3 (Cyrus, 918855994761) through the entire
  journey with REAL sends and REAL status webhooks:
  booked → pre_arrival → checked_in → checkout_pending → checked_out →
  review_requested.
  Messages (all delivered): 9 booking_confirmation, 10 checkin_info (via
  plain_text_v1), 11 checkout_reminder (via hello_world), 12 review_request
  (via order_confirmation_v1). journey_events: 6 rows, append-only, in order.
- How the ticks were driven for the test: guest 3 check_in/check_out were
  set to tomorrow (2026-09-17) in the DB, then server restarts triggered the
  boot date-tick (runDateTick). checkin/checkout driven by
  scripts/simulate.js checkin|checkout hitting the real HTTP endpoints.
- Temporary: PROACTIVE_DAILY_CAP raised to 4 for the walkthrough (guest
  already had 1 send that day; cap would have suppressed #3/#4 — correct
  behavior, wrong for a same-day demo). RESTORED to 2 afterwards.
- DB stores INTENDED template components (e.g. review_request vars with
  REVIEW_URL_PENDING placeholder); TEMPLATE_OVERRIDES changes only the
  transport (name/language/vars actually sent). Audit truth vs test transport
  are cleanly separated.
- To repeat a full walkthrough: use a NEW phone number each time (guest
  (phone, template) uniqueness blocks re-runs for the same guest+template),
  set check_in/check_out to tomorrow, restart server for each tick,
  simulate.js checkin/checkout, dispatch-now.js to drain.

Remaining for production (all Meta-side, user actions):
  1. Business verification (Exquisite Hospitality)
  2. Create the 4 real templates on production WABA (script ready)
  3. Register +91 88797 31627 (SMS code, number goes API-only)
  4. Add payment method for business-initiated messages
  5. Rotate the access token + app secret (were pasted in chat)
  6. Set real REVIEW_URL in .env

## 2026-09-16 (night) — Ops dashboard (custom, no Sheets)
- Decision (user chose): custom dashboard over Google Sheets. Postgres stays
  the only writable source; bookings arrive manually (calls/WhatsApp/walk-ins)
  so the dashboard's "Add guest" IS the booking entry point.
- What changed:
  - src/admin/routes.js — token-gated admin API at /admin/api/*
    (x-admin-token header, timing-safe compare, fail-closed 503 if
    ADMIN_TOKEN unset): GET guests (list w/ proactive_today), GET guests/:id
    (detail: messages/events/requests), POST guests (reuses the EXACT
    booking-webhook pipeline: handleBookingWebhook + applyEventToGuest
    booking_created — single code path), PATCH guests/:id (name/phone/room/
    dates/ai_paused; phone uniqueness 409; journey_state NOT editable by
    design — event-driven only).
  - public/admin/index.html — single-file vanilla JS UI (no framework/CDN):
    guest list w/ state badges, detail (profile form, pause AI, journey
    timeline, message log, requests), Add guest form. Token in localStorage.
  - server.js mounts router + express.static(public).
  - .env: ADMIN_TOKEN (also in .env.example with generation command).
- Verified: no token 401, wrong token 401, valid 200; static page 200;
  detail endpoint returns clean YYYY-MM-DD dates (to_char cast — raw pg date
  objects broke date inputs and would have wiped dates on save); tests 20/20.
- Gotchas fixed: auth middleware must gate /api/* only (not the static page);
  requests table columns are request_type/description (not kind/summary).
- Dashboard reachable: http://localhost:3100/admin/ and via the ngrok tunnel
  URL + same token (changes every ngrok restart).
- Scope note: this is an ops console, not the guest-facing "inbox UI" the
  brief deferred. Sheets sync deliberately NOT built (user chose dashboard).

## 2026-09-16 (late) — Activity broadcasts (community manager -> guests)
- What changed:
  - Migration 002: guests.activities_opt_out BOOLEAN (guest opt-out flag).
  - policy.js: activity kind blocked by activities_opted_out (journey
    messages unaffected by opt-out). 2 new tests (22 total).
  - triggers.js: countProactiveToday now counts templates AND activity
    sends (trigger_reason LIKE 'activity:%') — one unified daily cap.
    handleInboundCommand(guestId, cmd): exact STOP/START keywords (no LLM,
    no fuzzy matching) -> toggle opt-out + confirmation reply.
  - webhook.js: after storing inbound, exact STOP/START triggers the command.
  - src/agent/activities.js: createAndBroadcastActivity (insert activity,
    select in-property guests — checked_in/in_stay/checkout_pending —
    policy-check each individually, queue free_text with trigger_reason
    activity:{id}:policy_ok, dispatch, return reached/suppressed stats).
    listActivities w/ per-activity sent_count.
  - Admin API: POST /admin/api/activities, GET /admin/api/activities;
    PATCH guests/:id accepts activities_opt_out.
  - Dashboard: Activities card (left column, stacked under guests) with
    sent counts, "+ New activity" form (renders in detail pane), per-guest
    Activities ON/OFF toggle in profile.
  - scripts/simulate-inbound.js — signed inbound webhook simulator
    (node scripts/simulate-inbound.js --phone X --text "STOP").
- Verified live (real Meta traffic): activity broadcast delivered with clean
  formatted date; policy suppression shown twice (daily_cap_reached with
  cap 2 — honest; then activities_opted_out). STOP via simulated webhook
  opted the guest out + delivered confirmation. User then replied START
  from their REAL phone — Meta webhook processed it, opted back in,
  "Welcome back!" + new activity delivered. The full opt-in/opt-out loop
  ran with the user's actual phone.
- Bugs fixed during verification: pg DATE columns return JS Date objects —
  to_char casts added to activity INSERT RETURNING and listActivities
  (first broadcast said "Invalid Date").
- Product decision pending (flag to user): PROACTIVE_DAILY_CAP=2 counts
  journey templates AND activities together — with daily activity posts,
  2/day may be too tight; it is one line in .env to change.
- Known limits (by design): staff_manual sends are free-text only —
  outside the 24h session window Meta will reject (error lands in
  message log, visible in chat tab as failed + reason).

## 2026-09-16 (late night) — Database migrated to Supabase (managed Postgres)
- What changed:
  - .env DATABASE_URL now points at Supabase shared pooler
    (aws-0-ap-northeast-2.pooler.supabase.com:6543, project ecpxfmdceyadzkwrakxb),
    password percent-encoded.
  - src/db.js: automatic TLS for cloud Postgres (supabase/neon/etc. host
    detection) — local Docker stays non-SSL.
  - Migrations 001 + 002 applied to Supabase (fresh DB, all 7 tables).
  - New ops scripts: scripts/check-db.js (connection + row counts),
    scripts/check-messages.js (recent messages table).
- Verified live: health check ok against Supabase; booking webhook created
  guest 1 (Cyrus) in Supabase and the booking confirmation was delivered
  through Meta (status webhook confirmed delivered).
- Old local Docker DB (airco-agent-db-1) is no longer used by the app; it
  only holds early test data. Fresh start on Supabase — guests are
  re-added via the dashboard or the booking webhook.
- Two 'failed' sends in the LOCAL db (ids 21, 22) were dev-mode sandbox
  sends to numbers not on Meta's allowed list — correct fail-visible
  behavior, not a bug. Restriction disappears in Live mode.
- Deploy target decision: Railway for backend+dashboard (single service,
  serves API + static dashboard), Supabase for data. No Vercel split —
  the dashboard is static HTML served by Express; splitting adds CORS
  and sync overhead with zero benefit.

## 2026-09-16 (final) — DEPLOYED: Railway production live
- What was done:
  - Local git repo initialized; initial commit 7d24cd1 (40 files, secrets excluded).
  - Railway CLI linked: project Airco-Operations, environment production,
    service airco-operations (repo dscyrus07-dev/airco-operations, Southeast Asia).
  - All 12 app variables pushed via CLI (scripts/push-env.ps1): WhatsApp creds,
    DATABASE_URL (Supabase pooler), BOOKING_WEBHOOK_SECRET, ADMIN_TOKEN,
    PROACTIVE_DAILY_CAP=2, TEMPLATE_OVERRIDES. PORT left to Railway injection.
  - Redeployed with variables -> container started cleanly on :8080.
  - Meta webhook repointed via API (POST /{app-id}/subscriptions) to
    https://airco-operations-production.up.railway.app/webhook — active:true,
    field messages v26.0.
- Verified: public health endpoint returns {"ok":true,"db":"up","property":"Zostel Mumbai"} (HTTP 200).
- Production URL: https://airco-operations-production.up.railway.app
- Dev environment unchanged: local server on :3100 + Docker Postgres still work
  (note: local .env now points at Supabase, so local dev also uses the cloud DB).
- Remaining before real guests (user actions in Meta): business verification,
  production number registration, template approvals, payment method,
  credential rotation, Live mode switch.

## 2026-09-16 (end) — Deployment package prepared (Railway)
- What changed:
  - server.js: process-level safety — unhandledRejection logged (agent stays up),
    uncaughtException → graceful pool close + exit(1) so the supervisor restarts.
  - scripts/backup.js — dependency-free nightly DB dump to backups/*.json,
    30-backup retention. npm run backup.
  - DEPLOY.md — full Railway + Meta webhook + monitoring walkthrough
    (env var list, screen-by-screen steps, production checklist).
  - package.json: backup + db:check scripts. .gitignore: backups/ excluded.
- Verified: 22/22 tests; backup round-trip works; server boots against Supabase.
- Deploy target decision: Railway for backend+dashboard (single service,
  serves API + static dashboard), Supabase for data. No Vercel split —
  the dashboard is static HTML served by Express; splitting adds CORS
  and sync overhead with zero benefit.

## 2026-09-16 (night) — Dashboard v2: professional UX + staff workflows
- What changed (backend, src/admin/routes.js):
  - GET /admin/api/overview — arrivals today, departures today, in-house
    guests, message counts today. One query set, Kolkata-time based.
  - POST /admin/api/guests/:id/checkin | /checkout — staff-driven journey
    events via the same applyEventToGuest path as the PMS webhooks.
  - POST /admin/api/guests/:id/messages — staff manual reply (free_text,
    trigger_reason staff_manual; NOT counted in proactive cap — session
    reply, human-initiated).
- What changed (frontend, full rebuild of public/admin/index.html):
  - Three views via top nav: Today (default), Guests, Activities.
  - Today: 6 stat cards + arrivals (one-click Check in), departures
    (Check out with confirm), in-house list (Chat shortcut).
  - Guests: search box, avatar initials (name-hashed hue), flags for
    AI PAUSED / NO ACTIVITIES; detail = header w/ contextual actions
    (Check in/out, Pause AI, Activities toggle) + tabs Chat/Profile/Journey.
  - Chat tab: WhatsApp-style bubbles (in=left, out=right with template
    label, status coloring, failed error text), composer (Enter to send),
    24h window warning when guest's last inbound is older.
  - Activity form with live message preview; recent activities with
    sent counts.
  - Toasts, empty states, mobile-responsive (single column <1020px).
  - 15s auto-refresh per active view; composer never wiped while typing.
- Verified: 22/22 tests; overview endpoint; checkin endpoint (guest 2
  booked -> checked_in); staff manual message delivered to the real phone
  (message id 20, staff_manual, delivered).
- Known limits (by design): staff_manual sends are free-text only —
  outside the 24h session window Meta will reject (error lands in
  message log, visible in chat tab as failed + reason).
