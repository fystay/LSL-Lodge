# Staging readiness

Status: 10 October 2026, branch `claude/instant-booking`. Not merged, not
deployed; production (lsllodge.vercel.app) untouched. **Not ready for a
staging test yet**: the code is ready, but it needs a dedicated database,
a dedicated Stripe sandbox and a host (see "Blockers").

## What was reviewed and changed

**Payments, cancellations, refunds, hold release (security and
consistency).** Every path rechecked against the code:

- Confirmation only after verified payment (signed webhook, or the return
  page's server-to-server fetch of a session already recorded on that
  booking). The amount, currency, reservation and payment must all match.
  Duplicate and out-of-order webhooks are idempotent. `confirmed_at` and the
  deadline are set once (database trigger and check constraint).
- Refunds: created only by the guest policy (owner-recorded), automatically
  for money not owed, or by the owner (fresh second factor). A fixed
  idempotency key, capped at what's refundable, retried with backoff,
  shown as refunded only on Stripe's `succeeded`.
- Hold release: Stripe's "back" link needs the booking cookie and that
  checkout's payment ID. Paid or in-progress payments are never released;
  a payment landing on a released hold is refunded in full automatically.
  The worst a guest can do is release their own hold.
- Owner-recorded cancellations: OWNER role and fresh second factor; the
  claimed request time can't be in the future or before the booking.
- Every admin server action authorises (`requireAdmin("manage")`) before
  doing anything (19 actions checked).
- **Fixed:** Checkout now disables Stripe's Adaptive Pricing, so guests
  always pay in GBP (found in the Stripe sandbox; see below).

**Cancellation-request timestamps.** The audit entry records
`requestReceivedAt` (the claimed time), `requestTimeSource`
(`OWNER_ENTERED` or `SERVER_CLOCK`) and `recordedAt` (server time it was
recorded). The audit row's own `created_at` is the database's write time.
The booking stores the claimed time (`cancellation_requested_at`) and the
recording time (`cancelled_at`); the owner's booking page shows both.
Eligibility uses the claimed time, at minute precision.

**Stale calendar data.** New safety stop, on by default: while an enabled
Airbnb (or other) import has never synced, or has had no success for 60
minutes, the site takes no new holds, Checkout isn't started, and a payment
that arrives goes to the owner for review instead of confirming. Existing
bookings are untouched. The owner's alert explains the pause. Conflicts
(Airbnb dates over a hold, over checkout, at payment, after confirmation)
are tested in `holds`, `payments` and `sync` integration tests.

**Paid price box.** The approved correction: the schedule line reads "paid"
once payment is verified. No other UI change; visual regression against
production is 22/22.

## Verified (run on 10 October 2026)

| Check                                                                                                              | Result                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck, production build                                                                          | Pass                                                                                                                               |
| Unit tests                                                                                                         | 249 passed                                                                                                                         |
| Integration tests (PostgreSQL 16)                                                                                  | 145 passed                                                                                                                         |
| E2E, booking engine off                                                                                            | 67 passed (booking/admin-only skipped by design)                                                                                   |
| E2E, booking engine on                                                                                             | 99 passed; 29 skipped: 22 visual (run separately), 5 viewport-specific, 2 Stripe sandbox (need keys)                               |
| Visual regression vs production                                                                                    | 22/22                                                                                                                              |
| `drizzle-kit check`, `db:verify` (RLS, Data API roles denied, triggers, constraints)                               | Pass                                                                                                                               |
| `pnpm audit --prod`                                                                                                | No known vulnerabilities                                                                                                           |
| Scheduler soak (11 min, production build, 60 s timer)                                                              | 5-minute cadence, 0 overlapping runs, duplicate call refused, lapsed hold expired, health 503 → 200 ([SCHEDULER.md](SCHEDULER.md)) |
| Stripe API-level check (sandbox, via the connected login)                                                          | Session and refund requests accepted; real payloads pass our webhook path ([STRIPE-SANDBOX-TEST.md](STRIPE-SANDBOX-TEST.md))       |
| Owner auth (E2E): two-step sign-in, lockout, replay, idle/absolute expiry, viewer read-only, step-up, Origin check | Pass                                                                                                                               |

## Not configured (tests passing do NOT mean these work)

| Item                              | State                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase                          | **No Lodge project.** Creation refused: free-plan limit of 2 active projects reached by the owner's account. Migrations have only run on local PostgreSQL 16.     |
| Stripe                            | **No Lodge sandbox or keys** in any environment. "FYStay sandbox" belongs to another app (its webhooks received our test events). Sandbox plan scenarios not run. |
| Scheduler                         | Mechanism verified locally; **no hosted trigger** (pg_cron needs the Supabase project; Vercel Cron needs a deployment).                                           |
| Uptime monitor / error monitoring | Not configured (owner account needed). Health endpoint ready.                                                                                                     |
| Backups                           | None: there is no hosted database. Supabase free plan has daily backups only; PITR needs a paid plan. Restore never tested.                                       |
| Email (Resend)                    | Not configured; delivery off; no verified domain.                                                                                                                 |
| Airbnb sync                       | No feed link entered; only synthetic feeds tested. Without a source, the stale-data stop has nothing to check.                                                    |
| Google Calendar                   | Not built (assessment only).                                                                                                                                      |

## Blockers for a controlled staging test

1. **Supabase project for the Lodge** (owner: upgrade, free a slot, or use
   another organisation). Then `pnpm db:verify --migrate` against it
   ([SUPABASE-DEV-SETUP.md](SUPABASE-DEV-SETUP.md)).
2. **Dedicated Stripe sandbox for the Lodge**, its `sk_test_` key and
   webhook secret in the host's secret manager, and a webhook endpoint with
   API version `2026-09-30` and the checkout and refund events.
3. **A host for staging** (e.g. a Vercel preview/staging environment with
   the variables in `.env.example`); needs owner approval to deploy.
4. **Hosted scheduler** (pg_cron in the Supabase project, recommended) and
   an uptime monitor on `/api/health`.
5. **Airbnb export link** added in `/admin/calendars`, and the site's export
   link added to Airbnb.
6. Owner admin account via `pnpm admin invite` on staging.

Then run the 15 scenarios in [STRIPE-SANDBOX-TEST.md](STRIPE-SANDBOX-TEST.md)
and record results.

## Blockers for launch (beyond staging)

- Owner decisions: rates, fees, tax, minimum stay, check-in/out; hold
  length (30 min default); stale-feed window (60 min default) and the
  booking pause; owner-cancellation, no-show and amendment terms;
  cancellation policy page text; booking terms and privacy notice with
  legal review; email wording; late-payment rule.
- Resend account and verified sending domain (SPF, DKIM, DMARC).
- Error monitoring with PII scrubbing; backups (PITR) and a tested restore;
  incident runbooks; data-retention purge job; Stripe reconciliation job.
- Manual accessibility review and Core Web Vitals on a deployed preview.
- Live-mode approval, `SITE_INDEXABLE`, owner acceptance testing and
  explicit launch approval.
