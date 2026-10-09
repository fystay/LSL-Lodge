# Implementation plan

Status as of 9 October 2026. Phases 0–2 are implemented, plus the
host-approval workflow, test-mode Stripe payments, email notifications
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
- **Requests and holds are reservations.** `REQUESTED` (awaiting the owner),
  `APPROVED` (awaiting payment) and `PENDING_PAYMENT` (instant mode) each
  hold the dates until a required `hold_expires_at`. Holds and bookings share
  one table, so one constraint covers both. Past its deadline a hold stops
  blocking even before the sweeper marks it `EXPIRED`.
- **Exclusion constraint** `reservations_no_overlapping_active_stays`:
  `EXCLUDE USING gist (property_id WITH =, stay WITH &&) WHERE status IN
(REQUESTED, APPROVED, PENDING_PAYMENT, CONFIRMED, PAYMENT_DUE,
REQUIRES_REVIEW)`. Overlapping active stays are impossible at the database
  layer, whatever the application does.
- **Triggers**: legal status transitions only (mirrors
  `src/server/booking/reservation-state.ts`); website reservations can only be
  inserted as `REQUESTED` or `PENDING_PAYMENT`; an `APPROVED` row needs
  `approved_at`; quote snapshot, total and currency are immutable.
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

## 3. Booking and payment lifecycle (host approval, full payment)

The owner chose **host approval** and **full payment**. Nothing is charged
before the owner approves.

```
guest request ──► REQUESTED ──owner approves──► APPROVED ──verified payment──► CONFIRMED
 (dates held,        │  (deadline: response      │  (deadline: payment
  nothing charged)   │   window, default 24 h)   │   window, default 24 h)
                     ├─owner declines──► DECLINED (dates released)
                     └─no response────► EXPIRED  (dates released)
                                             APPROVED ─not paid in time─► EXPIRED
```

1. Guest searches. The server validates dates, occupancy, minimum stay and
   horizon, then prices the stay from versioned rate and fee rules.
2. Guest reviews the itemised quote (the full amount shown as "due once the
   owner approves"), the steps above and the terms, then sends a request.
3. `createHold` (one locked transaction) re-checks every block source and
   inserts a `REQUESTED` reservation holding the dates until the owner's
   deadline, with an immutable quote snapshot, the payment schedule, an audit
   entry and two queued emails (guest acknowledgement, owner alert).
4. The owner approves or declines in `/admin`. `approveRequest` re-checks the
   deadline and every other calendar (owner blocks, Airbnb, Google) under the
   property lock. Approval moves the hold to the guest's payment deadline and
   emails a signed link. Declining releases the dates at once.
5. The guest presses "Pay" on their booking page. `startCheckout` re-checks
   state, deadline and imported calendars, records a `PENDING` payment for
   the scheduled amount (never a client value) and creates a Checkout Session
   with a stable idempotency key, `client_reference_id` and metadata. The
   session never outlives the hold. Only one session can be live at a time.
6. **Only verified payment confirms.** `applyCheckoutSession` runs from the
   signature-verified webhook (event ID recorded in the same transaction) and
   from the return page's server-side session fetch. It requires: the session
   is recorded for this reservation and payment, paid, amount and currency
   match, the reservation is still `APPROVED` (or an instant hold), and no
   imported calendar now overlaps. Then `CONFIRMED` (or `PAYMENT_DUE` under a
   deposit plan), and confirmation emails are queued.
7. **Anything unusual goes to the owner, money is never silently kept or
   lost**: amount mismatch, duplicate payment, payment after expiry, or a new
   calendar clash → `REQUIRES_REVIEW` with a reason. If a late payment's dates
   were re-booked, the reservation stays `EXPIRED` and the payment is flagged
   "refund required". The owner is alerted in each case.
8. Expired requests and approvals are swept by `/api/jobs/expire-holds`,
   which also expires their open Checkout Sessions. Deadlines are also
   enforced at request time, so a missed run never double-books.
9. Refunds, cancellations and balance payments: not built yet; they depend on
   the owner's cancellation policy (section 7).

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

| Phase / milestone           | Scope                                                       | Status                                                                                              |
| --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0 Discovery                 | Stack, risks, prototypes                                    | **Done**                                                                                            |
| 1 Foundation                | App, schema, CI, design system, public pages                | **Done**                                                                                            |
| 2 Booking and pricing       | Pricing, availability, holds, admin                         | **Done**                                                                                            |
| Brief M1 Audit              | Repository audit, property facts register                   | **Done**: docs/property-facts-and-policies.md                                                       |
| Brief M2–M3 Requests        | Request statuses, migration, request holds, guest journey   | **Done**                                                                                            |
| Brief M4 Owner approval     | Approve/decline, decision panel, requests queue, settings   | **Done** (admin login is still local-only; see §7)                                                  |
| Brief M5 Test-mode payments | Checkout after approval, webhook, idempotency, review paths | **Done in code and tests**; not yet run against a Stripe sandbox (no test keys in this environment) |
| Brief M7 Email              | Outbox, templates, Resend adapter, dispatcher, preview      | **Done**; delivery off by default, not yet run against Resend                                       |
| Brief M6 Calendars          | Airbnb import, export feed, health, conflicts               | **Airbnb done**; Google Calendar not started (needs owner's Google Cloud project)                   |
| Brief M8 Readiness          | Quality gates, docs, launch checklist                       | **Done**: docs/LAUNCH-READINESS.md                                                                  |
| 5 Hardening and launch      | Audits, monitoring, backups, runbooks, UAT                  | Not started                                                                                         |

Test counts at the end of this work: 218 unit, 78 PostgreSQL integration,
and 88 end-to-end tests (desktop and mobile, including axe WCAG 2.2 AA
scans) with the booking engine on; 64 with it off.

## 7. Still open

**Blocked on owner decisions or accounts** (docs/OWNER-DECISIONS.md)

- Real rates, fees, minimum stay, taxes; cancellation, refund and no-show
  policy; booking terms. Quotes fail closed until rates exist.
- Confirm the response and payment windows (defaults 24 h each).
- A dedicated Supabase project. The two existing projects on the connected
  account belong to another application and hold its data, so no Lodge
  migration has been applied to Supabase. Everything was built and tested
  against local PostgreSQL 16 (Supabase runs 17; nothing used is
  version-specific).
- Stripe sandbox keys for the Lodge (an "FYStay sandbox" account exists on
  the connected Stripe login; confirm it is the right business).
- Resend account and verified sending domain.
- Google Cloud project and OAuth consent screen for Google Calendar.

**Engineering still to do**

- **Managed admin login with MFA** (Supabase Auth adapter). Until then admin
  works only locally (`ADMIN_AUTH_MODE=local` is refused on Vercel).
- **Cancellation and refunds** (owner and guest), including the refund for a
  "refund required" late payment, once the policy is approved. Today the
  owner refunds in the Stripe dashboard and the review reason records why.
- **Resolving review cases in admin** (confirm a reviewed paid booking, or
  record a refund). The state machine and checks exist; the UI doesn't yet.
- **Balance payments** for deposit plans (not needed for full payment).
- **Google Calendar** OAuth, free/busy import and app-calendar export.
- **Scheduler**: the three job routes need a scheduler (Vercel Cron needs
  the Pro plan for 5–15 minute polling, or Supabase `pg_cron`). Not
  configured: that is a deployment change needing approval.
- **Stripe reconciliation job**, monitoring (Sentry), backups and restore
  test, runbooks.
- Public pages still read facts from `src/content/property.ts`, not the
  database settings.

## 8. Booking modes and payment ordering

**Request mode (current, owner-chosen).** Guest requests, owner approves,
guest pays in full, booking confirms on verified payment. Trade-offs: no card
is ever charged or held for a declined request, so there is nothing to refund
or void on decline. The cost is a second step for the guest, and a gap of up
to the payment window between approval and confirmation, during which the
dates are held but not paid. If the guest doesn't pay, the dates come back.

**Alternative the owner could choose later: authorise at request time.**
Stripe can place a hold on the card (manual capture) when the request is
sent, captured on approval and released on decline. Smoother for guests, but
card holds lapse after about 7 days, declined guests see a pending charge for
a while, and the decline and expiry paths must void reliably. Not built;
needs the owner's sign-off and a defined void/expiry policy first.

**Instant mode (built, disabled).** `bookingMode = INSTANT` makes
`createHold` place a 30-minute payment hold (`PENDING_PAYMENT`) and the same
payment code confirms it. It is refused unless `INSTANT_BOOKING_APPROVED=true`.
Before enabling it:

1. Owner approves an instant-booking policy (who may book, cancellation
   terms) and the payment sequence.
2. The booking page shows the pay step straight after details (the
   `HOLD_AWAITING_PAYMENT` status page and pay button already exist) and is
   E2E-tested in that mode.
3. Rate limits and hold length are reviewed for abuse (instant holds are
   short, which limits it).
4. The admin settings page gets a control to switch modes (today it only
   displays the mode).
