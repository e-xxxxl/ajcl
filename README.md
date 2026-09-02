# AJ Courier Logistics — API (backend)

Express + Mongoose REST API. Split out of the original Next.js monolith; the
frontend (`../frontend`) is a separate Vite SPA that talks to this over HTTP with
`Authorization: Bearer <JWT>` tokens (no cookies).

## Local development

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI (Atlas), JWT_SECRET, admin creds
npm run db                    # optional: local MongoDB via mongodb-memory-server
npm run dev                   # tsx watch, http://localhost:4000
```

`GET /api/health` reports DB + integration status.

## Endpoints (all under `/api`)

- `auth/*` — signup, login, logout, me, forgot-password, reset-password (login/signup return `{ token, user }`)
- `vehicles` — public active-vehicle list
- `maps/*` — autocomplete, place, config (server fallback; the browser does the real map work)
- `bookings/*` — quote, list, `:reference` (GET/PATCH)
- `payments/*` — initialize, verify, webhook (raw body), mock-confirm
- `notifications/*` — list, read
- `admin/*` — login, stats, bookings, `bookings/:reference`, `bookings/:reference/status`, vehicles CRUD

## Deploy — Render (Web Service)

Fastest path: **New + → Blueprint** and point Render at the repo — it reads
`../render.yaml` and prompts for the secrets. Or configure manually:

- Root Directory: `backend`
- Build: `npm ci && npm run build`
- Start: `node dist/server.js`
- Health check path: `/`  (`/api/health` returns 503 until the DB connects, which
  would fail the deploy — use `/api/health` for manual diagnostics only)
- Instance: **Starter** (Free tier sleeps → cold starts fail the 20s Atlas timeout)
- Do **not** set `PORT` (Render provides it).
- Env vars: `MONGODB_URI`, `JWT_SECRET`, `SESSION_MAX_AGE=7d`,
  `FRONTEND_URL=https://<domain>` (comma-separate for more than one origin),
  `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `PAYSTACK_SECRET_KEY`,
  `PAYSTACK_CURRENCY=NGN`, `RESEND_API_KEY`, `EMAIL_FROM`, `SUPPORT_EMAIL`,
  `GOOGLE_MAPS_API_KEY` (optional).
- MongoDB Atlas → Network Access → allow `0.0.0.0/0` (Render IPs are dynamic).
- After the first deploy: Paystack dashboard → webhook URL →
  `https://<app>.onrender.com/api/payments/webhook`.

CORS is locked to `FRONTEND_URL`. Paystack `callback_url` is
`${FRONTEND_URL}/book/payment/callback` (first origin if several).
