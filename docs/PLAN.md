# Implementation plan

Status as of 8 October 2026. Phases 0 and 1 are implemented in this repository.
Nothing is deployed, no live payments are enabled and no real emails are sent.

## 1. Stack and rationale

| Concern          | Choice                                                                                     | Why                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework        | **Next.js 16.4** (App Router, React 19.3, TypeScript 5.9)                                  | Current stable release. Server Components keep pricing and availability logic on the server. Cache Components gives static public pages and a fresh, request-time availability search.                                                                               |
| Styling          | **Tailwind CSS 4.3** + small owned components (`src/components`)                           | Design tokens live in one `@theme` block. No heavy template to fight.                                                                                                                                                                                                |
| Database         | **PostgreSQL 16 via Supabase** (proposed, UK/EU region)                                    | Managed Postgres with backups/PITR, plus Supabase Auth (MFA) for the admin area, all from one vendor a small business can administer. Supports `btree_gist` for exclusion constraints. Neon remains a drop-in alternative because the app only needs a Postgres URL. |
| ORM / migrations | **Drizzle ORM 0.45 + drizzle-kit**                                                         | SQL-first, light, committed SQL migrations; hand-written migrations for what an ORM can't express (exclusion constraints, triggers).                                                                                                                                 |
| Admin auth       | **Supabase Auth** with TOTP MFA and an email allowlist (Phase 2)                           | Proven managed auth; every server action re-checks the session and role.                                                                                                                                                                                             |
| Payments         | **Stripe Checkout** (hosted), server-created sessions                                      | Smallest PCI scope; SCA is handled by Stripe.                                                                                                                                                                                                                        |
| Calendar         | Google Calendar API (OAuth 2.0) + iCal import/export for Airbnb                            | See section 4 and [INTEGRATIONS.md](INTEGRATIONS.md).                                                                                                                                                                                                                |
| Email            | **Resend or Postmark**, behind `EmailSender` (`src/server/notifications/email.ts`)         | Owner to choose; the interface makes the swap cheap.                                                                                                                                                                                                                 |
| Hosting          | **Vercel** (proposed)                                                                      | First-class Next.js support and Cron. Calendar polling every 5–15 minutes needs the **Pro** plan (Hobby cron runs at most daily); alternatively Supabase `pg_cron` + `pg_net` can call the job endpoint.                                                             |
| Background jobs  | Durable job rows in Postgres + an authenticated `/api/jobs/*` tick called by the scheduler | No in-memory timers. Jobs are idempotent, retried with backoff and jitter, and visible in admin.                                                                                                                                                                     |
| Testing          | Vitest 5 (unit + Postgres integration), Playwright 1.56 + axe-core (E2E, WCAG 2.2 AA)      | Matches the charter's quality gates.                                                                                                                                                                                                                                 |
| Monitoring       | Sentry (errors) + uptime monitor + owner alert emails (Phase 5)                            | Owner to confirm accounts.                                                                                                                                                                                                                                           |

Deviations from the charter's defaults: none. Supabase and Vercel are proposals
pending the owner's agreement (cost, data residency, account ownership).

## 2. Data model and overlap prevention

Schema: `src/server/db/schema.ts`. Migrations: `drizzle/`. It covers every
entity in charter §14: properties, rate rules, fee rules, payment policies,
reservations, payment schedule items, payments, owner blocks, external
calendar sources, external busy periods, calendar event links, webhook events,
notification jobs and audit logs.

Key rules:

- Stay dates are `DATE` columns (property-local calendar dates). Each range
  table has a generated `stay daterange` column, bounds `[)`: check-in is
  inclusive and check-out exclusive, so same-day turnover works.
- Money is integer pence plus an ISO currency code.
- **A hold is a reservation in `PENDING_PAYMENT` with a required
  `hold_expires_at`.** Holds and bookings share one table, so one constraint
  covers both.
- **Exclusion constraint** `reservations_no_overlapping_active_stays`:
  `EXCLUDE USING gist (property_id WITH =, stay WITH &&) WHERE status IN
(PENDING_PAYMENT, CONFIRMED, PAYMENT_DUE, REQUIRES_REVIEW)`. Overlapping
  active stays are impossible at the database layer, whatever the application
  does.
- **Triggers**: legal status transitions only (mirrors
  `src/server/booking/reservation-state.ts`); website reservations can only be
  inserted as `PENDING_PAYMENT`; quote snapshot, total and currency are
  immutable.
- Owner blocks and imported external busy periods live in separate tables
  (external periods may legitimately overlap a direct booking, which is a
  _conflict to surface_, not a row to reject). Hold creation (Phase 2) runs in
  one transaction: lock the property row (`SELECT … FOR UPDATE`, which
  serialises booking writes for the property), expire stale holds, check owner
  blocks, external busy periods and turnover buffer, then insert. The
  exclusion constraint is the final backstop.
- Proven by `src/server/booking/overlap-protection.integration.test.ts`
  against real PostgreSQL: 15 simultaneous overlapping inserts give exactly
  one success; same-day turnover is allowed; expired holds free dates; a late
  payment can't revive an expired hold whose dates were re-sold; the DB
  trigger matches the TypeScript state machine for all 56 status pairs.

## 3. Stripe booking and payment lifecycle

1. Guest searches. The server validates dates, occupancy, minimum stay and
   horizon, then prices the stay from versioned rate and fee rules.
2. The guest reviews the itemised quote, cancellation terms and payment
   schedule (due now and later, with dates).
3. The server creates the hold transactionally (with an idempotency key),
   status `PENDING_PAYMENT`, expiry around 30 minutes, and stores the
   immutable quote snapshot and schedule items.
4. The server re-checks conflicts, then creates a Checkout Session
   (mode `payment`) for the due-now amount, with a stable Stripe idempotency
   key, `client_reference_id` = reservation ID and session `expires_at`
   aligned with the hold.
5. The redirect back shows "confirming…" only. **The verified webhook
   decides.** `checkout.session.completed` /
   `checkout.session.async_payment_succeeded` is processed only if:
   signature valid (raw body), event ID not already processed (unique
   `webhook_events` row, in the same transaction), amount, currency and
   reservation match, and the reservation is still in a confirmable state.
6. Transition: full payment goes to `CONFIRMED`; deposit goes to
   `PAYMENT_DUE` (balance scheduled).
7. **Payment succeeded but hold expired or dates conflicted:** the move to
   `REQUIRES_REVIEW` is attempted. If the dates are free, the owner confirms
   or refunds. If the exclusion constraint rejects it, the reservation stays
   `EXPIRED`, the payment is flagged, the owner is alerted and a refund is
   issued under the documented policy. Money is never silently kept or lost.
8. Balance: a reminder job sends a secure, expiring link that creates a fresh
   Checkout Session for the outstanding schedule item. Payment updates the
   item to `PAID` and the reservation to `CONFIRMED`.
9. Cancellation and refunds follow the owner-approved policy (never inferred
   from payment status alone); Stripe refund events update payment records;
   disputes raise an owner alert.
10. A nightly reconciliation compares Stripe balance transactions with the
    internal payment records.

The Phase 0 prototype (`src/server/payments/stripe-webhook.ts`) verifies
signatures using stripe-node 23 (API `2026-09-30.endive`). Tests cover a valid
signature, a tampered body, re-serialised JSON, the wrong secret and replays
outside tolerance. No webhook route is exposed yet: acknowledging events
without processing them would tell Stripe they were handled.

## 4. Calendar sync design (Google and Airbnb)

**Latency limitation, stated plainly:** Airbnb iCal feeds are refreshed on
Airbnb's schedule, not ours. Polling every 5–15 minutes is a _target for our
side_; Airbnb may take considerably longer to publish a new booking in its
export, or to read our export and block dates. Neither direction is real-time
or guaranteed. There is always a window in which a guest could book the same
dates on both channels. The design narrows that window and makes it visible;
it cannot close it. Only a channel manager with an official Airbnb API
connection can offer near-real-time two-way sync. See
[INTEGRATIONS.md](INTEGRATIONS.md).

- **Import (Airbnb → site):** the owner pastes the Airbnb export URL in admin.
  It is encrypted at rest (AES-256-GCM, `src/server/crypto/credentials.ts`)
  and fetched by `fetchFeed` (`src/server/calendar/safe-fetch.ts`): https
  only, Airbnb host allowlist, public-IP-only DNS checked at connect time,
  manual redirects, 10 s timeout, 2 MB cap, ETag/Last-Modified. Parsing
  (`ical-parse.ts`) keeps only UID, dates and status, with no guest names.
  Reconciliation (`import-plan.ts`) upserts by UID and never hard-deletes. If
  a feed suddenly drops every upcoming block, the removals are held for owner
  review: a provider glitch can't release booked dates. On fetch or parse
  failure, the last known good blocks stay in force and the source is marked
  `ERROR`, then `STALE`.
- **Export (site → Airbnb):** a token-protected `/calendar/<token>.ics` feed
  of direct reservations and owner blocks only. It never re-exports blocks
  imported from Airbnb, so there is no sync loop. The owner adds this URL to
  Airbnb's "Import calendar".
- **Google Calendar:** OAuth 2.0 with least-privilege scopes:
  - `calendar.app.created`: the app creates its own "Lodge on the Lake
    bookings" calendar and can only touch events there, so it can never delete
    the owner's other events.
  - `calendar.events.freebusy`: reads _busy times only_ from calendars the
    owner chooses. No event titles or guest details are fetched.
  - Refresh token encrypted at rest; connect, reconnect, revoke and
    disconnect flows; 401/403/429/5xx handling with backoff. Free/busy has no
    sync tokens, so the chosen calendars are polled over the booking horizon
    (with pagination of the time window), and the app-created calendar is
    reconciled against `calendar_event_links` (events carry the reservation ID
    in `extendedProperties.private`).
- **Conflicts:** any external busy period that overlaps a blocking direct
  reservation creates a high-priority admin conflict with provenance. Neither
  side is overwritten; the owner resolves it explicitly.
- **Health:** last attempt and last success per source, consecutive failures,
  a stale threshold, "Sync now", and owner alerts after repeated failures.

The Phase 0 prototype covers the Airbnb side end to end in tests (parse,
safety checks, reconciliation). Google OAuth is designed but **not
prototyped**: it needs the owner's Google Cloud project and OAuth consent
screen (see owner decisions).

## 5. Owner decisions and credentials

See [OWNER-DECISIONS.md](OWNER-DECISIONS.md). Credentials are never pasted
into chat or committed: the owner enters them directly in the hosting
provider's secret manager (names listed in `.env.example`).

## 6. Milestones and test gates

| Phase                  | Scope                                                                                                         | Exit gate                                                                              | Status                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0 Discovery            | Stack, risks, prototypes: iCal parsing, SSRF-safe fetch, Stripe signature verification, credential encryption | Architecture, providers, risks and owner inputs documented                             | **Done** (Google OAuth prototype pending credentials)                                                                           |
| 1 Foundation           | App, schema and migrations, CI, design tokens, layout, accessible primitives, gallery, public pages           | Build passes; pages responsive and accessible                                          | **Done**: build, 146 unit, 11 integration and 48 E2E tests with axe all pass locally. Content is placeholder pending the owner. |
| 2 Booking and pricing  | Pricing engine and quote snapshots, availability service, holds, admin auth, admin calendar and owner blocks  | Concurrency tests prove overlapping stays can't both confirm (DB layer already proven) | Next                                                                                                                            |
| 3 Stripe and comms     | Checkout, webhooks, schedule, balance links, refunds, reconciliation, email provider, notification jobs       | Stripe test-mode E2E incl. duplicate and failed webhooks                               |                                                                                                                                 |
| 4 Calendar sync        | Airbnb import/export, Google OAuth and sync, conflict queue, health UI, alerts                                | Documented sync tests; visible failure handling; no real-time claims                   |                                                                                                                                 |
| 5 Hardening and launch | Full audits, monitoring, backups and restore test, runbooks, owner UAT                                        | All charter §19 criteria; explicit owner launch approval                               |                                                                                                                                 |
