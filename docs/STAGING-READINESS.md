# Staging readiness

Status: 10 October 2026, branch `claude/instant-booking`. Not merged.
Production (lsllodge.vercel.app) serves this branch with no environment
variables, so its booking engine is off; nothing here changed it.

**Staging is not ready, and a complete booking can't yet be demonstrated
there.** The code, the demo tooling and the deployed-journey test are
ready; staging still needs a Lodge database, a Lodge Stripe sandbox and the
branch's Preview variables (see "Blockers"). Setup recipe:
[STAGING-SETUP.md](STAGING-SETUP.md). Demo script and scenario coverage:
[DEMO.md](DEMO.md).

## Demo-readiness work (10 October 2026, latest)

- **Staging recipe** ([STAGING-SETUP.md](STAGING-SETUP.md)): isolated
  database options with costs and permissions; branch-scoped Preview
  variables; migrations, demo seed, owner invite; webhook; scheduler;
  protection bypass and sharing.
- **`pnpm demo seed|status|reset`** (`scripts/demo.mts`): placeholder
  property and prices; reset deletes only test-domain bookings and
  `[DEMO]`-labelled blocks and calendar sources, and only on a database
  marked by `seed`, on a confirmed host, without a live Stripe key.
  Verified locally: a real booking, a real block, a real owner account and
  their payment survived reset; the guards refused a non-local host, a live
  key and an unmarked database.
- **`pnpm stripe:test-setup`** (`scripts/stripe-test-setup.mts`): creates or
  updates the staging webhook in the **Lodge** sandbox only. Refuses live
  keys, a key from a different account than named, and any account that
  already sends webhooks elsewhere (as the other app's sandbox does). Dry
  run by default; the signing secret goes only to the operator's terminal
  or a mode-600 file. Refusal paths verified offline; Stripe rejected a
  fake key before anything was created. **Not run against a real
  sandbox** (none exists).
- **Deployed-journey test** (`e2e/staging-journey.spec.ts`, opt-in) and
  Playwright remote mode (`E2E_BASE_URL`). Rehearsed against a local
  production build with Stripe off: the 5 non-payment journeys pass, twice
  in a row with a reset between (holds block other guests and the owner;
  owner blocks; Airbnb dates block; stale feed pauses bookings; expired
  hold frees dates; forged webhook refused). **The 6 Stripe journeys have
  never run** (payment, duplicate/out-of-order replay, cancellation and
  refund, declined card and hold release, refund failure, late payment).
- **Fixed: refunds Stripe fails after accepting them.** Previously a
  `refund.failed` (e.g. a closed card) was recorded but nobody was told,
  and a booking already shown as refunded stayed "refunded". Now the
  booking returns to "refund in progress", is flagged
  `REFUND_FAILED_AT_PROVIDER`, the owner is alerted once, and the amount
  can be refunded again. A failed or cancelled refund is final, so a
  delayed "succeeded" event can't flip it back. Migration `0010` (additive:
  replaces the status-transition function to allow REFUNDED →
  REFUND_PENDING). Owner-screen text only; no guest-facing change.

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
| Integration tests (PostgreSQL 16)                                                                                  | 146 passed                                                                                                                         |
| E2E, booking engine off                                                                                            | 67 passed (booking/admin-only skipped by design)                                                                                   |
| E2E, booking engine on                                                                                             | 99 passed; 51 skipped: 22 visual (run separately), 22 staging journey (opt-in), 5 viewport-specific, 2 Stripe sandbox              |
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

## Blockers for the customer demo on staging

All need the owner's access or approval; none can be done from here
without it.

1. **A Lodge database** (choose an option in
   [STAGING-SETUP.md](STAGING-SETUP.md) §1; recommended: free Supabase
   under a separate account).
2. **A Lodge Stripe sandbox** (free) and its test keys.
3. **Approval to add Preview variables** for the branch on Vercel, and a
   Protection Bypass for Automation secret.
4. Then, on the operator's machine: migrate, `pnpm demo seed`,
   `pnpm admin invite`, `pnpm stripe:test-setup --apply`, redeploy the
   branch, and run the staging journey in full
   ([STAGING-SETUP.md](STAGING-SETUP.md) §5–7). **Only when that passes is
   staging demo-ready.**

Not needed for the demo: a hosted scheduler, an Airbnb feed, email
sending, monitoring.

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
