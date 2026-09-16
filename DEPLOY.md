# Deploying Airco Agent — Railway + Supabase

This is the one-time deployment guide. Local dev keeps working exactly as before.

## Architecture (final)

```
GitHub repo
   └─ Railway  →  Node agent (webhook + API + dashboard)   ← one service
        └── Supabase (managed Postgres) — source of truth
Meta WhatsApp Cloud API  ──webhook──▶  Railway URL
```

One service, one database, no CORS, no split frontend. The dashboard is
static HTML that Express already serves at `/admin`.

---

## Step 1 — Push the code to GitHub

1. Create a **private** GitHub repository (e.g. `airco-agent`).
2. From the `airco-agent` folder:

```
git init
git add .
git commit -m "Airco Agent — initial production build"
git branch -M main
git remote add origin https://github.com/<your-username>/airco-agent.git
git push -u origin main
```

Never commit `.env` — it is already gitignored.

## 2. Create the Railway service

1. Go to **railway.app** → log in with GitHub → **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway detects Node.js automatically. Settings → **Start Command**: `node server.js` (already in package.json).
3. **Variables** tab → add every variable from your local `.env`:
   - `WHATSAPP_ACCESS_TOKEN` (the permanent System User token — never the 24h dashboard token)
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_VERIFY_TOKEN` (same value as local)
   - `WHATSAPP_WABA_ID`
   - `WHATSAPP_APP_ID`
   - `DATABASE_URL` (the Supabase pooler string)
   - `PORT` (Railway sets its own — delete this var and let Railway inject it, or set 3100)
   - `BOOKING_WEBHOOK_SECRET`
   - `ADMIN_TOKEN`
   - `PROACTIVE_DAILY_CAP`
   - `REVIEW_URL` (real review link before go-live)
   - Do NOT set `WHATSAPP_DRY_RUN` in production.
4. Settings → Networking → **Generate Domain** → note the URL, e.g. `https://airco-agent-production.up.railway.app`
5. Deploy. Railway runs `npm start` automatically.

## 3. Run migrations once against Supabase

From your local machine (one time):

```
npm run migrate
```

with `DATABASE_URL` pointing at Supabase. Already done in this session —
skip unless you create a new Supabase project.

## 4. Point Meta at the deployed URL

1. **developers.facebook.com** → app **Zostel(mumbai) AI** → **WhatsApp → Configuration**
2. Callback URL: `https://<your-railway-domain>/webhook`
3. Verify token: the same `WHATSAPP_VERIFY_TOKEN` value you set in Railway
4. Subscribe to the `messages` field (already subscribed — verify it shows Subscribed)
5. Test: send a message to the test number; check Railway logs for the webhook POST.

## 5. Nightly backups

- Supabase handles backups on paid plans; on the free tier run:
  `npm run backup` (writes `backups/airco-backup-<timestamp>.json`, keeps last 30)
- Schedule it daily: Windows Task Scheduler → daily task → `npm run backup`
  (or a cron job on the host).

## 6. Monitoring

- Create a free UptimeRobot (or similar) monitor: HTTP GET `https://<your-app>/health`
  every 5 minutes → email alert on failure.
- The dispatch loop self-heals: queued messages are retried on boot and every 15 minutes.

## Production checklist (do before real guests)

- [ ] Business verification for Exquisite Hospitality (Meta dashboard)
- [ ] Register production number +91 88797 31627 on Cloud API (SMS code; number becomes API-only)
- [ ] Create the 4 real templates on the production WABA (`npm run create-templates` with the production WABA ID)
- [ ] Add payment method for business-initiated (template) messages
- [ ] Rotate WhatsApp access token + app secret; rotate Supabase DB password
- [ ] Set real `REVIEW_URL` in the environment
- [ ] Switch the app from Development mode to Live mode in Meta dashboard
