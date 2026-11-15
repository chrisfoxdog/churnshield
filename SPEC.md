# ChurnShield — Product Spec (MVP)

**Owner:** Elite Software Studio (Chris)
**Status:** MVP built locally 2026-11-14. Not yet registered as a Whop app, not deployed, no pricing set — those are launch decisions (see "Launch sequence" below).

## Product promise

ChurnShield is the member-save system for Whop creators. It watches the creator's own Whop membership and payment events, flags the members who are about to churn — cancel scheduled, payment failed, gone quiet — and turns each flag into a save task with a ready-to-send message draft.

**Copy rule (hard):** ChurnShield reports the creator's own real numbers only — members at risk, dollars at risk, members saved, dollars saved, all computed from that creator's actual webhook events and the plan amounts Whop reported. It never promises income, growth, or a save rate; it never shows projected, estimated, or sample numbers; there are no testimonials and no demo data anywhere in the product. An empty account shows an honest empty state.

## MVP scope

**In:**
- Company-scoped Whop webhook ingestion with Standard Webhooks signature verification and full idempotency (envelope message id processed at most once).
- Member records keyed by Whop membership id + user id, created and maintained purely from webhook events. Display name falls back to "Member" (v1 payloads carry no name/email).
- Risk engine: `cancel_scheduled` and `payment_failed` (event-driven, stored) + `silent` (derived at read: no membership/payment event in N days, default 14, creator-configurable 1–90). The UI labels silent honestly as a webhook-events-only signal.
- Save tasks: opened automatically by cancel-scheduled and payment-failed risks (one open task per member + risk), closed as `saved` / `lost` by the creator, or `recovered` automatically when the risk clears on its own (cancel switched off, payment succeeds, member reactivates). Deactivation closes open tasks as `lost`.
- Dashboard (owner-only, Whop JWT): metrics row, save inbox, members table, settings.
- Playbook drafts: built-in templates (cancel-save, failed-card, silent check-in) with the member's real product filled in; optional Gemini polish when `GEMINI_API_KEY` is set, always labeled by source (`template` vs `gemini`). Drafts only — the app never sends messages; the creator copies and sends in Whop/Discord.
- Storage: Postgres in production (`DATABASE_URL`), local JSON store in dev — the same store layer pattern as AutoCash AI / CoachDesk / Nexus.

**Out (deliberately, for later versions):**
- Sending messages (no Whop/Discord/email sending in MVP).
- Whop API calls of any kind (`WHOP_API_KEY` accepted in env for parity, unused in v1).
- Member-facing pages (the dashboard is the creator's only).
- Automated discounts/pauses or any write-back to a member's subscription.
- Cross-checkout analytics, cohorts, or any metric not derivable from the events above.

## Event map (current Whop catalog only)

| Event | Effect |
|---|---|
| `membership.activated` | Create/reactivate member (status active); clear churn + all risks; close open tasks as recovered; snapshot product title + plan amount when present |
| `membership.updated` | Refresh snapshot + last-event; apply cancel flag if the payload carries one |
| `membership.cancel_at_period_end_changed` | Flag on → `cancel_scheduled` risk + open save task. Flag off → risk cleared, task closed as recovered |
| `payment.failed` | `payment_failed` risk + open save task |
| `payment.succeeded` | Clear `payment_failed` risk; close its task as recovered. No prior failure → no-op |
| `payment.created` | Refresh snapshot + last-event only |
| `membership.deactivated` | Status churned; open tasks closed as lost. Never-seen member → record created as churned |
| anything else | Recorded (minimized) and acknowledged 200, no state change |

Events are applied in the order received: a deactivation followed by an activation leaves the member active, and vice versa.

## Data model

- `creators` — one tenant per Whop company: company id, bound owner user id, display name, `silent_threshold_days`.
- `members` — creator id, whop user id, whop membership id, display name ("Member" fallback), product id/title, plan (variant) id, plan amount (dollars, nullable — never invented) + currency, status (active/churned), stored risks, first/last event stamps, churned_at.
- `save_tasks` — creator id, member id, kind (cancel_scheduled/payment_failed), status (open/saved/lost/recovered), amount snapshot at open, opened-via event id, closed_at.
- `webhook_events` — envelope message id (unique — the idempotency key), type, result, minimized payload (IDs/statuses/amount only).
- `audit_log` — owner binding + creator task resolutions.

Metrics are computed at read time from these records; nothing is cached or pre-aggregated.

## Launch sequence — still needs Chris's decisions

1. **GitHub repo** — create `chrisfoxdog/churnshield` (Chris's call; this build is local-only until then).
2. **Whop app registration** — register the ChurnShield app under Elite Software Studio, set base URL after deploy.
3. **Pricing** — Chris decides (the other Elite apps sit at $29/mo + $199 lifetime; ChurnShield's tiers are his call, nothing is priced in code).
4. **Deploy** — Render Free web service + Neon Postgres branch, the standard Elite pattern; env per README; register the production webhook and capture its secret into Render only.
5. **Purchase gate** — the standard Elite $0-plan live test: buy → activation event → member record; cancel → save task; deactivate → churned; cancel the test membership → downgrade path verified.
6. **Keep-alive** — add the health URL to the existing 10-minute ping cron so the free server stays warm for webhook delivery.
7. **App Store submission** — listing + gallery, submitted only on Chris's approval, like the other three apps.
