# ChurnShield — Member Retention for Whop Creators

ChurnShield is Elite Software Studio's member-save system for Whop creators. It connects to a creator's Whop store through webhooks and watches for the moments a member is about to be lost:

- **Cancel scheduled** — a member turned on cancel-at-period-end
- **Payment failed** — a card didn't go through
- **Silent** — no membership or payment event for a member in 14+ days (configurable)

Each cancel/payment risk opens a **save task** in the creator's dashboard, with a **playbook draft** (cancel-save, failed-card, silent check-in) ready to copy and send in Whop or Discord. The creator marks tasks saved or lost; risks that clear on their own (member un-cancels, payment retry succeeds) close as recovered automatically.

Every number ChurnShield shows — active members, at-risk count, dollars at risk, members saved, dollars saved, churned — is computed live from the creator's own real webhook events and the plan amounts Whop reported. There is no demo data, no seeded members, and no projected or estimated figures anywhere. ChurnShield makes no promises about income or save rates; it shows you who needs attention and what actually happened.

See **SPEC.md** for the product spec, event map, and data model.

## Stack

React 19 + Vite + Tailwind 4 frontend, Express + TypeScript server, Postgres in production / local JSON store in development — the same architecture as Elite's other apps (AutoCash AI, CoachDesk, Nexus Terminal).

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Production | Postgres connection string (e.g. Neon). Production refuses to start without it. Dev falls back to `data/store.json`. |
| `WHOP_WEBHOOK_SECRET` | Yes | From the Whop webhook you register for this app. Inbound webhooks are rejected (401) without it. Never commit a real value. |
| `WHOP_COMPANY_ID` | Yes (prod) | The Whop company (biz_…) the app is installed in. Tenant key for all records. |
| `WHOP_APP_ID` | No | The registered Whop app id; reported on `/api/health` for diagnostics. |
| `WHOP_API_KEY` | No | **Unused in the MVP.** Accepted for parity with Elite's other apps; v1 makes no Whop API calls (webhook-in, dashboard-out). |
| `GEMINI_API_KEY` | No | Optional. Playbook drafts are template-generated and fully functional without it. When set, drafts may be polished by Gemini and are labeled `source: "gemini"`; template drafts are labeled `"template"` — never presented as AI-written. |
| `APP_URL` | No | Public URL of the deployed service. |
| `PORT` | No | Defaults to 3000. Render assigns this automatically. |
| `SILENT_MEMBER_DAYS` | No | Default silent threshold (14). Each creator can override it (1–90) in dashboard settings. |
| `NODE_ENV` | Yes (prod) | Set to `production` in production — this disables the dev-auth fallback and requires `DATABASE_URL`. |

Copy `.env.example` to `.env` for local development.

## Run locally

```bash
npm install
npm run dev        # tsx server.ts on :3000 (Vite dev server proxies /api)
npm test           # full guardrail + lifecycle + hardening suite
npm run build      # vite build + esbuild server bundle -> dist/
npm start          # node dist/server.js
node scripts/smoke.mjs   # boots a dev server and drives the signed-webhook save flow
```

Local dashboard access (dev only): open the app with `?dev_user=<any id>` — the server honors the dev identity header only when `NODE_ENV` is not `production`. In Whop, identity comes from the verified Whop user token (JWKS), and production fails closed.

To exercise webhooks locally, POST Standard-Webhooks-signed events to `/api/webhooks/whop` (see `scripts/smoke.mjs` for a working signer).

## Deploy (the Elite pattern)

1. Create a Neon Postgres database/branch for ChurnShield; keep the connection string for step 3.
2. Create a Render Free web service from this repo: build `npm install && npm run build`, start `node dist/server.js`.
3. Set env: `NODE_ENV=production`, `DATABASE_URL`, `WHOP_COMPANY_ID`, `WHOP_APP_ID`, `APP_URL`.
4. In the Whop developer dashboard, register a company webhook pointing at `https://<service>.onrender.com/api/webhooks/whop` for the membership + payment events, and put the issued secret in Render as `WHOP_WEBHOOK_SECRET` (enter it in Render directly — never via chat or git).
5. Verify: `GET /api/health` shows `ok: true`, database `postgres`, `whopConfigured: true`; then run the standard Elite $0 purchase gate before flipping anything visible.

## Honest scope notes

- ChurnShield **never sends messages**. Playbook output is a draft for the creator to copy, edit, and send themselves.
- The **silent** flag is based on webhook events only — the only activity signal this version receives. A member can be active in a community without producing a membership/payment event; the UI says exactly this.
- Whop v1 webhook payloads carry **no member name or email**, so records show "Member" until/unless a payload provides a name. Records are keyed by Whop membership id + user id.
- Saved/at-risk dollar figures sum **plan amounts Whop reported**. Members whose amount wasn't reported count in headcounts and add nothing to dollar totals — unknown amounts are never guessed.
