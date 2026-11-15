# ChurnShield v1 (MVP) — Smoke Summary

Built 2026-11-14 for Elite Software Studio, mirroring the CoachDesk reference implementation (same stack, store layer, webhook verification, JWKS identity). Local only: no GitHub push, no Whop app registration, no Whop API calls, no deploy, no secrets in the repo. Chris's direction on top of the brief: "Make it solid" — see the Hardening section.

## What was built

- **Data layer** (`server/db.ts`): 5 entities (creators, members, save_tasks, webhook_events, audit_log) as TypeScript types + a store interface with two implementations: Postgres (one JSONB table per entity, real `creator_id` column + tenant index, transactional, unique index on the webhook envelope id as an idempotency backstop) and a dev JSON file store (snapshot transactions). Production refuses to start without `DATABASE_URL`.
- **Webhooks** (`server/whop.ts`): `POST /api/webhooks/whop`, raw body verified **before** any JSON parsing — Standard Webhooks HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, key = base64-decoded secret bytes after stripping the prefix (raw form also accepted, matching Elite's other apps), 5-minute timestamp window, 401 on bad signature with zero state change, 400 on malformed JSON. Dedupe on the envelope message id (`msg_…`) before writes and again inside the transaction. Minimized payload logging (IDs/statuses/amount only).
- **Lifecycle**: activation creates/reactivates the member (clears churn + risks, open tasks → recovered); cancel-at-period-end flag on → `cancel_scheduled` risk + save task, flag off → risk cleared + task recovered; payment.failed → `payment_failed` risk + task; payment.succeeded → risk cleared + task recovered (no prior failure = clean no-op); deactivation → churned + open tasks closed as lost (never-seen member → record created as churned); unknown event types recorded and acknowledged. One open task per (member, risk) — repeat signals can't stack tasks. Events apply in received order (deactivated-then-activated ends active).
- **Identity**: `x-whop-user-token` verified against Whop's JWKS via `jose` with **no algorithms restriction** (Whop's exp-proxy signs ES256 — the Nexus lesson). Creator scope = tenant from `WHOP_COMPANY_ID`; first verified identity on a fresh install binds as owner. Production fails closed (401) with **no dev-header fallback** (checked dynamically per request); DB failure → `503 DATABASE_UNAVAILABLE`, never fake data.
- **Metrics** (`server/metrics.ts`): computed at read time from real records only — active members, at-risk count, dollars at risk, open tasks, saved count, dollars saved, lost/recovered counts, churned count. Dollar sums skip members whose plan amount Whop never reported (null), never treating unknown as an invented number. **Silent** risk is derived here: active member whose last webhook event is older than the creator's threshold (default 14 days, settings range 1–90).
- **Playbooks** (`server/playbooks.ts`): template drafts for cancel-save / failed-card / silent-check-in with the member's real product title filled in ("Member" name fallback never produces a "Hey Member" greeting). If `GEMINI_API_KEY` is set, a draft may be Gemini-polished with a strict no-new-claims prompt and an 8s timeout; any failure falls back to the template. The API returns `source: 'template' | 'gemini'` and the UI labels it. Drafts only — nothing is ever sent.
- **Dashboard UI**: metrics row, save inbox (open tasks with Draft / Mark saved / Mark lost, recently-closed list), members table (status, risk badges with the honest silent explainer, last event), playbook draft viewer with copy button and source label, silent-threshold setting. Elite brand tokens (black/midnight-blue, electric-blue `#35A7FF`), dark default + light theme like CoachDesk. Honest empty states everywhere — a fresh install shows "No member events yet" and explains that every number comes from real events.
- **No seed/demo data anywhere.** The dev store ships empty.

## Verification (all run 2026-11-14)

- `npm install` — clean (156 packages).
- `npm test` — **27/27 passing** (list in the Hardening section).
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (Vite frontend + esbuild server bundle `dist/server.js`, 42.5 KB).
- Bundled-server smoke: `node dist/server.js` boots, `/api/health` returns healthy, SPA is served with the ChurnShield title.
- Dev-server smoke (`node scripts/smoke.mjs`, temp store, dev identity): actual output below.

### Smoke output (verbatim excerpts, 2026-11-14 run)

```
== GET /api/health ==
{
  "ok": true,
  "status": "healthy",
  "environment": "development",
  "database": { "ok": true, "type": "file", "details": "Local JSON store (development only)" },
  "whopConfigured": true,
  "whopApiKeySet": false,
  "whopAppIdSet": false,
  "geminiConfigured": false
}

== POST membership.activated (member joins, $29 plan) ==
{ "status": 200, "json": { "received": true, "status": "processed",
  "message": "Member record created for user user_smoke_1 — now being watched." } }

== POST membership.cancel_at_period_end_changed (cancel flag ON) ==
{ "status": 200, "json": { "received": true, "status": "processed",
  "message": "Cancel scheduled for user user_smoke_1 — save task opened." } }

== Dashboard after cancel: member ==
[ { "display_name": "Member", "product_title": "Smoke Test Community",
    "plan_amount": 29, "status": "active", "risks_all": ["cancel_scheduled"] } ]

== Dashboard after cancel: open tasks ==
[ { "kind": "cancel_scheduled", "status": "open", "amount": 29,
    "member_product_title": "Smoke Test Community" } ]

== Dashboard after cancel: metrics ==
{ "active_members": 1, "at_risk_count": 1, "dollars_at_risk": 29, "open_tasks": 1,
  "saved_count": 0, "dollars_saved": 0, "lost_count": 0, "recovered_count": 0,
  "churned_count": 0, "currency": "USD" }

== POST payment.failed ==
{ "status": 200, "json": { "received": true, "status": "processed",
  "message": "Payment failed for user user_smoke_1 — save task opened." } }

== POST payment.succeeded (recovery) ==
{ "status": 200, "json": { "received": true, "status": "processed",
  "message": "Payment succeeded for user user_smoke_1 — payment risk cleared, task recovered." } }

== Member after payment recovery ==
[ { "status": "active", "risks_all": ["cancel_scheduled"] } ]

== Tasks after payment recovery ==
[ { "kind": "cancel_scheduled", "status": "open" },
  { "kind": "payment_failed", "status": "recovered" } ]

SMOKE OK: health 200, cancel opened a save task, payment failure recovered on payment.succeeded.
```

## Hardening (Chris: "Make it solid")

Checked and covered before calling this build done:

- **Idempotency** — envelope message id is the dedupe key (pre-check + in-transaction re-check + unique Postgres index). Whop retries cannot double-create tasks or double-count metrics. *Tests: #11 (same msg id twice → `duplicate`, one task, metrics deep-equal), #12 (same risk, new msg id → still one open task).*
- **Edge cases** — *Tests: #18 unknown event type (200, recorded ignored, no state change); #19 missing money/product fields (record + task created, amount null, dollar metrics skip nulls); #17 deactivation of a never-seen member (record created as churned, no crash) and out-of-order deactivated→activated (active wins); #15 payment.succeeded with no prior failure (200 no-op); #13 cancel flag turning OFF (risk cleared, task recovered).*
- **Failure behavior** — *Tests: #5 bad signature → 401 with zero state change (no event row, no member); #6 stale timestamp → 401; #7 malformed JSON with valid signature → 400, server alive; #23 store failure on dashboard reads → 503 `DATABASE_UNAVAILABLE` (fail closed, no fake data) with recovery; #24 store failure on the webhook route → 500 so Whop retries instead of the event being swallowed.*
- **Security self-check** — raw-body verification runs before any JSON parsing use (webhook route is registered before `express.json`); timestamp window enforced (300s); production has no dev-auth fallback (*test #3 flips `NODE_ENV` mid-run — identity reads it dynamically per request)*; repo scanned for secret-shaped literals — none (test fixtures use obvious dummy secrets, same as CoachDesk); every dashboard route sits behind the JWT/dev identity guard + creator role + tenant scoping (*tests #2, #4, #26*), and `/api/health` exposes only booleans; repo scanned for income-promise copy — none.
- **Code review pass** — after the suite passed, `server.ts`, `server/whop.ts`, `server/db.ts`, and `server/metrics.ts` were re-read against the four points above. Findings: (1) the verifier tries both the base64-decoded and raw secret forms — deliberate, matches how Elite's other apps accept dashboard secrets, and *test #8* proves the true Standard Webhooks form (prefixed base64 secret, signed with the decoded bytes); (2) `payment.*` events resolve their membership via `membership_id` only (their own `data.id` is a payment id), falling back to the member's user id — payload-shape correct; (3) no code changes were needed from the review — the items it surfaced are the documented stubs below. Full suite + build + smoke were re-run after the review.

### Test list (27)

1. Health shape (ok, database, whopConfigured) · 2. Unauthenticated dashboard routes → 401 · 3. Production mode: no dev fallback · 4. Owner binding + second user 403 · 5. Bad signature → 401, no state change · 6. Stale timestamp → 401 · 7. Malformed JSON → 400 · 8. Standard Webhooks secret format verifies; money/product extracted; "Member" fallback · 9. Activation creates member · 10. Cancel on → risk + task + dollars at risk · 11. Idempotent duplicate delivery · 12. No stacked tasks per member+risk · 13. Cancel off → recovered · 14. Payment failed → task; succeeded → recovered · 15. Succeeded with no prior failure → no-op · 16. Deactivation after cancel → churned + task lost · 17. Never-seen deactivation → churned record; later activation wins · 18. Unknown event → 200 ignored · 19. Missing optional fields → null amounts, metrics skip · 20. Silent radar derivation · 21. Template drafts (source label, product fill, silent draft) · 22. Resolve validation 400/404/409 · 23. Store-down dashboard → 503 · 24. Store-down webhook → 500 · 25. Metrics fixture math (active 4, at-risk 3, $40 at risk, saved 1/$50, churned 1) · 26. Tenant scoping · 27. Silent-threshold setting validation + effect.

## Assumptions, stubs, and known simplifications (deliberate MVP scope)

- **Tenant owner binding**: the tenant row is created on first webhook/visit with `whop_user_id` empty; the first verified identity to open the app binds as the owner (that is the person who installed it). Recovery if ever mis-bound: clear `creators.whop_user_id` in the database. Flagged here rather than hidden — same stub as CoachDesk.
- **`@whop/sdk`** is declared (per the Elite stack) but the MVP makes **no Whop API calls** — identity is JWKS, lifecycle is webhooks. `WHOP_API_KEY` is env-accepted and unused in v1.
- **Money extraction** reads the payload's money object (`amount`, with `total`/`price` fallbacks) in dollars as Whop reports it. Exact payment-payload field placement should be confirmed against a live event during the purchase gate (the standing Elite sandbox/live-gate step in SPEC.md) — unknown amounts stay null rather than guessed.
- **Cancel-flag extraction** reads `cancel_at_period_end` (plus two defensive aliases, or a concrete `cancel_at` date). A `cancel_at_period_end_changed` event whose payload carries none of these is recorded without a risk change rather than guessed at.
- **`membership.updated`** creates a minimal active record for an unknown member (keeps last-event/silent math honest) and does not map arbitrary `status` strings onto the lifecycle — activation/deactivation events own status transitions.
- **A member with multiple memberships**: records are keyed by membership id; an event that arrives with only a user id resolves to that user's first record. Per-membership records keep amounts and tasks separate when the membership id is present (the normal case).
- **Silent** is a read-time derivation, so no silent *task* is created — the dashboard offers a check-in draft per silent member instead. If creators want silent tasks in the inbox, that's a v1.1 change.
- **Gemini enhancement** is best-effort polish with a no-new-claims prompt, 8s timeout, and silent fallback to the labeled template; it is never required for a draft.
- **Postgres path** is implemented and type-checked but not exercised against a live Postgres in this build (local-only scope — no database was provisioned). The full suite runs against the JSON store; the Postgres store shares the same interface and query shapes, as with CoachDesk.
