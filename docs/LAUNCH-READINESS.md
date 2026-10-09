# Launch readiness

As of 9 October 2026. **Not ready to launch**, by design: no live payments,
no public bookings, no real emails, no production database. This page lists
what is verified, what is blocked, and what has to happen before the owner
can approve launch.

## Verified (commands actually run)

| Check                                                             | Result                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm format:check`, `lint`, `typecheck`                          | Pass                                                                                             |
| `pnpm test` (unit)                                                | 218 passed                                                                                       |
| `pnpm test:integration` (PostgreSQL 16)                           | 78 passed                                                                                        |
| `pnpm build` (production)                                         | Pass                                                                                             |
| `pnpm test:e2e`, booking engine off                               | 64 passed, 28 skipped (booking-only tests)                                                       |
| `pnpm test:e2e`, booking engine on                                | 88 passed, 4 skipped (layout-specific); desktop and mobile; axe WCAG 2.2 AA scans included       |
| `pnpm audit --prod --audit-level high`                            | No known vulnerabilities                                                                         |
| Migration 0002 on a fresh DB and as an upgrade with existing rows | Pass                                                                                             |
| Production-build smoke test of `/api/webhooks/stripe`             | Unsigned and tampered → 400; signed → 200 and recorded once; job routes → 401 without the secret |

What the tests prove, among other things:

- Concurrent overlapping requests: exactly one succeeds (database exclusion
  constraint plus property lock), including requests awaiting approval.
- The database enforces the same state machine as the code, for every pair
  of the 11 statuses; website rows can only start as a request or hold.
- A request can't be paid before approval, after decline, or after its
  deadline; payment can't confirm without matching amount, currency,
  reservation and payment record; duplicate and concurrent webhook
  deliveries apply once; late, duplicate, mismatched or clashing payments go
  to the owner and are never lost.
- Approve and decline racing each other: exactly one wins.
- Imported Airbnb periods block bookings; failed fetches keep the last good
  import; an emptied feed's removals are held; clashes are alerted once
  without changing either record; the export feed never re-exports imports
  or guest details.
- Email jobs send once, retry with backoff, survive a crashed runner, are
  cancelled when stale, and are recorded as "not sent" when delivery is off.

## Not verified (no access, or not yet possible)

- **Stripe sandbox**: no Lodge test keys in this environment. Payment code is
  tested with signed synthetic events and an in-memory gateway, not against
  Stripe.
- **Resend**: no account configured; the adapter is tested against a fake
  HTTP endpoint.
- **Supabase**: no dedicated project. The two projects on the connected
  account belong to another application; nothing was applied to them.
- **Real Airbnb feed**: tested with synthetic feeds only.
- **Rate-limit wiring in the running app** is covered by review and types;
  the limiter itself is integration-tested.
- Manual screen-reader review; performance (Core Web Vitals) on devices.

## Launch checklist

### Owner decisions (docs/OWNER-DECISIONS.md)

- [ ] Rates, fees, taxes, minimum stay, check-in/out times
- [ ] Response and payment windows
- [ ] Cancellation, refund, no-show and amendment policy; booking terms;
      privacy notice (legal review)
- [ ] Property facts confirmed (bed sizes, "waterfront" wording, amenities,
      house rules)
- [ ] Accounts: Supabase project, Stripe account, Resend and domain DNS,
      Google Cloud (optional), scheduler, monitoring
- [ ] Late-payment rule (honour if free, or always refund)

### Engineering

- [ ] Managed admin login with MFA (Supabase Auth adapter)
- [ ] Cancellation and refund workflow; resolving review cases in admin
- [ ] Scheduler calling the three job endpoints
- [ ] Stripe reconciliation job; error monitoring (Sentry) with PII scrubbing;
      uptime and failure alerts
- [ ] Run the full journey against a Stripe sandbox and Resend's sandbox
- [ ] Data retention schedule and purge job
- [ ] Backups (PITR) enabled and a restore tested; runbooks (calendar outage,
      payment reconciliation, double booking, restore, disabling bookings)
- [ ] Public pages read confirmed facts from the database settings
- [ ] Google Calendar integration, if the owner wants it

### Deployment (each needs explicit owner approval)

- [ ] Production database migrated as a controlled step
      (`DATABASE_URL_UNPOOLED=… pnpm db:migrate`)
- [ ] Secrets set in the platform secret manager: `DATABASE_URL`,
      `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`,
      `GUEST_LINK_SECRET`, `CALENDAR_EXPORT_SECRET`,
      `CREDENTIALS_ENCRYPTION_KEY`, email settings, admin settings
- [ ] Stripe webhook endpoint registered for the four `checkout.session.*`
      events
- [ ] Live mode: `STRIPE_LIVE_MODE_APPROVED=true` (owner approval)
- [ ] Real email: `EMAIL_DELIVERY=resend`, `EMAIL_LIVE_DELIVERY_APPROVED=true`
      (owner approval, verified domain)
- [ ] Booking flow on: today it is hard-disabled on Vercel production
      (`bookingFlowEnabled()`); lifting that is a code change made only at
      launch
- [ ] `SITE_INDEXABLE=true`, owner acceptance testing, **explicit launch
      approval**
