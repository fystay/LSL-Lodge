# Implementation plan

Status as of 10 October 2026. Phases 0–2 are implemented, plus instant
booking (no host approval) with the owner's 24-hour cancellation policy,
test-mode Stripe payments, email notifications
(delivery off by default) and Airbnb iCal sync from the engineering brief.
See section 7 for what is still open and docs/LAUNCH-READINESS.md for the
launch checklist. Nothing is deployed to production, no live payments are
enabled and no real emails are sent.

## 1. Stack and rationale

| Concern          | Choice                                                                                     | Why                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework        | **Next.js 16.4** (App Router, React 19.3, TypeScript 5.9)                                  | Current stable release. Server Components keep pricing and availability logic on the server. Cache Components gives static public pages and a fresh, request-time availability search.                                                                               |
| Styling          | **Tailwind CSS 4.3** + small owned components (`src/components`)                           | Design tokens live in one `@theme` block. No heavy template to fight.                                                                                                                                                                                                |
| Database         | **PostgreSQL 16 via Supabase** (proposed, UK/EU region)                                    | Managed Postgres with backups/PITR, plus Supabase Auth (MFA) for the admin area, all from one vendor a small business can administer. Supports `btree_gist` for exclusion constraints. Neon remains a drop-in alternative because the app only needs a Postgres URL. |
| ORM / migrations | **Drizzle ORM 0.45 + drizzle-kit**                                                         | SQL-first, light, committed SQL migrations; hand-written migrations for what an ORM can't express (exclusion constraints, triggers).                                                                                                                                 |
| Admin auth       | **App-managed accounts** with password + TOTP, server-side sessions, roles                 | Built on Node crypto only, independent of any provider (no Supabase project exists yet). Every page and action re-checks the session and role. See SECURITY.md.                                                                                                      |
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
- **Holds are reservations.** A new booking is a `PENDING_PAYMENT`
  reservation that holds the dates until a required `hold_expires_at` (35
  minutes, extended only to cover an open Stripe session). `REQUESTED` and
  `APPROVED` remain in the enum for rows from the retired request mode but
  can no longer be created. Holds and bookings share
  one table, so one constraint covers both. Past its deadline a hold stops
  blocking even before the sweeper marks it `EXPIRED`.
- **Exclusion constraint** `reservations_no_overlapping_active_stays`:
  `EXCLUDE USING gist (property_id WITH =, stay WITH &&) WHERE status IN
(REQUESTED, APPROVED, PENDING_PAYMENT, CONFIRMED, PAYMENT_DUE,
REQUIRES_REVIEW)`. Overlapping active stays are impossible at the database
  layer, whatever the application does.
- **Triggers**: legal status transitions only (mirrors
  `src/server/booking/reservation-state.ts`); website reservations can only be
  inserted as `PENDING_PAYMENT` (migration 0008); quote snapshot, total,
  currency, `requested_at` and `cancellation_policy` are immutable;
  `confirmed_at` and `free_cancellation_until` can be set once (from null)
  and never changed (migration 0009), and a check constraint ties the
  deadline to `confirmed_at + 24 h`; owner blocks and blocking
  reservations can't overlap in either direction
  (`reservations_owner_block_overlap`, `owner_blocks_booking_overlap`, each
  taking the property lock so a racing block and booking can't both
  commit).
- **Migration note**: `drizzle/0002_host_approval_workflow.sql` replaces the
  status enum type rather than adding values, because drizzle applies all
  pending migrations in one transaction and PostgreSQL won't use a new enum
  value in the transaction that added it. Tested on a fresh database and as
  an upgrade with existing rows.
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

## 3. Booking and payment lifecycle (instant booking, full payment)

The owner chose **instant booking** and **full payment upfront** (October
2026), replacing the earlier host-approval flow. There is no approval step;
only a verified payment confirms a booking.

```
guest details ──► PENDING_PAYMENT ──verified payment──► CONFIRMED ──guest cancels <24 h──► REFUND_PENDING ──► REFUNDED
 (requested_at;      │ (hold 30 min)     (confirmed_at,      ├──guest cancels ≥24 h (acknowledged)──► CANCELLED
  no deadline yet)   │                    deadline = +24 h)  └──owner cancels──► CANCELLED (+ owner's refund decision)
                     ├─guest releases──► CANCELLED
                     └─not paid in time─► EXPIRED
```

1. Guest searches. The server validates dates, occupancy, minimum stay and
   horizon, then prices the stay from versioned rate and fee rules. The
   availability page (production's design, unchanged) shows the total.
2. The details page (production's design plus one sentence) says the
   24-hour free-cancellation period starts once payment is confirmed. No
   deadline is shown before payment because none exists yet.
3. `createHold` (one transaction under the property lock) expires lapsed
   holds, re-checks every block source (bookings, live holds, owner blocks,
   imported Airbnb/Google periods, turnover buffer), prices the stay with
   the payment plan forced to FULL, and inserts a `PENDING_PAYMENT`
   reservation held for 30 minutes, with `requested_at = now` and the policy
   ID (`FULL_REFUND_WITHIN_24H_OF_CONFIRMATION`) but no deadline, plus the
   schedule and an audit entry. No email yet.
4. The same server action calls `startCheckout` and redirects to Stripe's
   hosted page (only `https://checkout.stripe.com/` URLs are followed).
   `startCheckout` re-checks state, hold expiry and imported calendars,
   records a `PENDING` payment for the scheduled amount and creates the
   session with a stable idempotency key, metadata and a message beside the
   pay button saying the 24 hours start once payment is confirmed. Stripe
   needs sessions to last at least 30 minutes, so starting Checkout extends
   the hold to cover the session. If Stripe isn't reachable the guest sees
   their held booking with a "Pay" button.
5. **Only verified payment confirms.** `applyCheckoutSession` runs from the
   signature-verified webhook (event ID recorded in the same transaction)
   and from the return page's server-side session fetch. It requires the
   session to belong to this reservation and payment, be paid, match amount
   and currency, the reservation to still be a live hold, and no imported
   calendar to overlap. Then, in one update, `CONFIRMED`, `confirmed_at =`
   the server's verification time and `free_cancellation_until =
confirmed_at + 24 h` (both only if still unset), and the confirmation
   emails (with the deadline) are queued.
6. **Anything unusual goes to the owner; money is never silently kept or
   lost.** Amount mismatch, payment after the hold lapsed (dates still free)
   or a new calendar clash → `REQUIRES_REVIEW`. Money that isn't owed for
   any stay (a duplicate payment, or a payment landing on a cancelled or
   re-sold booking) is refunded in full automatically and the owner is
   alerted.
7. Lapsed holds are swept by `/api/jobs/expire-holds` (also expiring their
   Checkout Sessions). Expiry is also enforced at booking and payment time.

### Cancellation policy (owner-confirmed)

"Guests can cancel within 24 hours of their booking being paid and confirmed
for a full refund; after that the booking is non-refundable." Implemented in
`src/server/booking/cancellation-policy.ts` and `guestCancel`:

- **The clock starts at verified payment.** `confirmed_at` is the server's
  time when it first verified the payment and confirmed the booking (signed
  webhook, the return page's server-side Stripe fetch, or the owner
  confirming a booking that needed review). Not the booking submission
  (`requested_at`), the hold, Checkout creation or anything from the
  guest's device. `free_cancellation_until = confirmed_at + 24 h` is written
  in the same update.
- **Set once.** The confirming update uses `COALESCE`, so it only fills
  these when empty; a trigger refuses any later change; a check constraint
  enforces `free_cancellation_until = confirmed_at + 24 h`. Duplicate,
  delayed or out-of-order webhooks and re-confirmation after a review can't
  move the deadline (tested). A delayed webhook that is the first
  verification starts the clock when it arrives.
- **Before payment** there is no deadline; guests are told the 24 hours
  start once payment is confirmed (details page, Stripe's page, booking
  page). A paid-but-unverified hold has no deadline; cancelling it releases
  the hold, and a payment that lands afterwards is refunded in full
  automatically.
- **Boundary:** a cancellation is refundable only if the server receives it
  **strictly before** `free_cancellation_until`. Exactly at the deadline,
  or later, it is non-refundable. Tests cover 1 ms before, exactly at and
  1 ms after the confirmation-based deadline, plus a daylight-saving
  change. Guests see the deadline rounded
  down to the minute, in UK time, so what they see is never later than the
  real deadline.
- Within the window: the booking is cancelled and a full refund of every
  verified charge is queued in the same transaction (`REFUND_PENDING`),
  then sent to Stripe with a fixed idempotency key. The booking becomes
  `REFUNDED` only when Stripe reports the refund `succeeded` (response or
  `refund.*` webhook). Failed sends retry with backoff via the
  `process-refunds` job; after 6 attempts the refund is marked FAILED and the
  owner alerted.
- After the window: the guest must tick "I understand I will not receive a
  refund"; the booking is cancelled with no refund created.
- Unpaid holds can be released at any time; a payment still settling blocks
  cancellation until it resolves.
- Owner cancellations are outside the guest policy: the owner decides any
  refund from the booking page.

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

The Airbnb side is implemented (import job, admin health page, export feed,
conflict alerts; see docs/INTEGRATIONS.md). Google OAuth is designed but
**not built**: it needs the owner's Google Cloud project and OAuth consent
screen (see owner decisions).

## 5. Owner decisions and credentials

See [OWNER-DECISIONS.md](OWNER-DECISIONS.md). Credentials are never pasted
into chat or committed: the owner enters them directly in the hosting
provider's secret manager (names listed in `.env.example`).

## 6. Milestones and test gates

| Phase / milestone           | Scope                                                     | Status                                                                                              |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0 Discovery                 | Stack, risks, prototypes                                  | **Done**                                                                                            |
| 1 Foundation                | App, schema, CI, design system, public pages              | **Done**                                                                                            |
| 2 Booking and pricing       | Pricing, availability, holds, admin                       | **Done**                                                                                            |
| Brief M1 Audit              | Repository audit, property facts register                 | **Done**: docs/property-facts-and-policies.md                                                       |
| Brief M2–M3 Requests        | Request statuses, migration, request holds, guest journey | **Replaced** by instant booking (October 2026)                                                      |
| Brief M4 Owner approval     | Approve/decline, decision panel, requests queue, settings | **Removed** with instant booking; owner dashboard kept                                              |
| Brief M5 Test-mode payments | Checkout, webhook, idempotency, review paths              | **Done in code and tests**; not yet run against a Stripe sandbox (no test keys in this environment) |
| Instant booking             | Holds → Checkout, 24 h policy, refunds, block editing     | **Done in code and tests**; same Stripe caveat                                                      |
| Brief M7 Email              | Outbox, templates, Resend adapter, dispatcher, preview    | **Done**; delivery off by default, not yet run against Resend                                       |
| Brief M6 Calendars          | Airbnb import, export feed, health, conflicts             | **Airbnb done**; Google Calendar not started (needs owner's Google Cloud project)                   |
| Brief M8 Readiness          | Quality gates, docs, launch checklist                     | **Done**: docs/LAUNCH-READINESS.md                                                                  |
| 5 Hardening and launch      | Audits, monitoring, backups, runbooks, UAT                | Not started                                                                                         |

Test counts after the instant-booking change: 245 unit, 125 PostgreSQL
integration, and 96 end-to-end tests (desktop and mobile, including axe WCAG
2.2 AA scans) with the booking engine on; 64 with it off.

## 7. Still open

**Blocked on owner decisions or accounts** (docs/OWNER-DECISIONS.md)

- Real rates, fees, minimum stay, taxes; no-show and owner-cancellation
  terms; booking terms and legal review. The 24-hour guest cancellation
  policy is confirmed and implemented. Quotes fail closed until rates exist.
- Whether to stop taking bookings while an Airbnb feed is stale.
- A dedicated Supabase project. The two existing projects on the connected
  account belong to another application and hold its data, so no Lodge
  migration has been applied to Supabase. Everything was built and tested
  against local PostgreSQL 16 (Supabase runs 17; nothing used is
  version-specific).
- Stripe sandbox keys for the Lodge (an "FYStay sandbox" account exists on
  the connected Stripe login; confirm it is the right business).
- Resend account and verified sending domain.
- Google Cloud project and OAuth consent screen for Google Calendar.

**Engineering still to do** (status in docs/LAUNCH-READINESS.md)

- Admin sign-in: done (docs/SECURITY.md). Passkeys and in-dashboard user
  management not built.
- Cancellations and refunds: the 24-hour guest policy, automatic refunds
  with retries, owner cancellations and owner-chosen refunds are done;
  Stripe reconciliation (comparing Stripe's records with ours) is not.
- Background jobs: done (docs/SCHEDULER.md); a scheduler and an uptime
  monitor still need configuring.
- Supabase: RLS and a guarded migrate/verify script done
  (docs/SUPABASE-DEV-SETUP.md); no dedicated project yet.
- Stripe sandbox run: plan and opt-in spec ready (docs/STRIPE-SANDBOX-TEST.md),
  not run.
- Google Calendar: assessed (docs/GOOGLE-CALENDAR.md), not built.
- Stripe reconciliation job, error monitoring, retention/purge job,
  backups and restore test, runbooks.
- Public pages still read facts from `src/content/property.ts`.

## 8. Booking mode history

Request mode (guest requests, owner approves, guest pays) was built first
and replaced by instant booking at the owner's request in October 2026.
What changed:

- Removed: `src/server/booking/requests.ts` (approve/decline),
  `src/server/booking/mode.ts` and `INSTANT_BOOKING_APPROVED`, the admin
  decision panel, the "requests awaiting your decision" queue, the
  response/payment window settings, the request/approval/decline/expiry
  emails, and the guest "withdraw" and "ask to cancel" paths.
- Kept for existing data: the `REQUESTED`, `APPROVED` and `DECLINED`
  statuses, `approved_*`/`declined_*` columns and the
  `booking_mode`/`request_response_hours`/`payment_window_hours` columns
  (unused; dropping them would be a destructive migration). New rows can't
  use the old statuses (database trigger).
- Deposit plans: the data model and quote engine still support them, but
  pricing is forced to FULL and the admin action refuses DEPOSIT.
