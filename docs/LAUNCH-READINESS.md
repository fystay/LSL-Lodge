# Launch readiness

As of 10 October 2026 (staging-readiness review). See also [STAGING-READINESS.md](STAGING-READINESS.md). **Not ready to launch**, by design: no
live payments, no public bookings, no real emails, no production database,
no scheduler configured. This page lists what is verified, what was only
simulated, and what blocks launch.

## Verified (commands actually run, local PostgreSQL 16)

| Check                                    | Result                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `lint`, `typecheck` | Pass                                                                                                                                                                                               |
| `pnpm test` (unit)                       | 249 passed                                                                                                                                                                                         |
| `pnpm test:integration`                  | 145 passed                                                                                                                                                                                         |
| `pnpm build`                             | Pass                                                                                                                                                                                               |
| `pnpm test:e2e`, booking engine off      | 67 passed (booking/admin-only tests skipped)                                                                                                                                                       |
| `pnpm test:e2e`, booking engine on       | 99 passed, 7 skipped (5 layout-specific, 2 Stripe sandbox needing keys)                                                                                                                            |
| Visual regression vs production          | 22/22 match (11 public routes × desktop/mobile; baselines from production's commit, checked against the live site)                                                                                 |
| `pnpm audit --prod --audit-level high`   | No known vulnerabilities                                                                                                                                                                           |
| `drizzle-kit check` and regeneration     | Schema and 9 migrations consistent                                                                                                                                                                 |
| `pnpm db:verify` on the local database   | All checks pass (tables, constraints, triggers incl. block/booking overlap, indexes, RLS)                                                                                                          |
| Production-build smoke tests             | Webhook: unsigned/tampered → 400, signed → recorded once. Jobs: unauthenticated → 401, tick runs all jobs then "not due", overlapping call skipped. Health: 503 before runs, problems listed after |
| Mutation checks                          | Disabling the MFA requirement, the Origin check, the amount check, or the property lock in the block/booking triggers each makes its tests fail                                                    |

What the tests prove, among other things:

- Booking integrity (instant booking): concurrent overlapping bookings,
  one winner; owner blocks and bookings can never overlap, even when
  written at the same moment; the database state machine matches the code
  for every status pair; new bookings can only start as an unpaid hold; a
  lapsed or released hold can't be paid.
- Cancellation policy: refundable 1 ms before the deadline, not exactly at
  it or after; the 24 hours run from verified payment (webhook or
  server-side check), not the booking; duplicate, delayed and out-of-order
  webhooks can't move the deadline; the
  deadline can't be changed in the database; a late cancellation needs an
  explicit acknowledgement; concurrent cancels refund once.
- Payments (simulated Stripe): verified, idempotent confirmation; duplicate
  and out-of-order webhooks; amount mismatch, late and duplicate payments go
  to the owner; refunds only up to what was paid, idempotent, tracked by
  webhooks, and never calculated from a policy.
- Admin: two-step sign-in with authenticator codes, lockout, code replay
  refused, session idle/absolute expiry and revocation, viewer can't change
  anything, step-up for sensitive changes, requests without a same-site
  Origin refused.
- Jobs: no overlapping runs, crashed leases recover, timeouts and failures
  recorded, health goes red when a job is overdue or work backs up.
- Supabase readiness: RLS on every table; the Data API roles are denied.

## Simulated or not yet run

| Area                                                    | Status                                                                                                                                   | Why                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Stripe                                                  | Signed synthetic events + in-memory gateway only. `e2e/stripe-sandbox.spec.ts` and docs/STRIPE-SANDBOX-TEST.md are ready but **not run** | No Lodge test keys configured                                                 |
| Supabase                                                | Migrations **not applied** anywhere but local                                                                                            | No dedicated project; the two existing projects belong to another application |
| Scheduler                                               | Job system verified locally; **no scheduler configured**                                                                                 | Needs an owner decision (pg_cron or Vercel Cron) and deployment access        |
| Uptime monitor                                          | Not configured                                                                                                                           | Owner account needed                                                          |
| Resend                                                  | Fake HTTP endpoint only                                                                                                                  | No account/domain                                                             |
| Airbnb                                                  | Synthetic feeds only                                                                                                                     | No feed link entered                                                          |
| Google Calendar                                         | Not built (assessment in docs/GOOGLE-CALENDAR.md)                                                                                        | No OAuth client or approval                                                   |
| Manual screen-reader review, Core Web Vitals on devices | Not done                                                                                                                                 | Needs a deployed preview and devices                                          |

## Launch blockers

### Owner decisions and accounts (docs/OWNER-DECISIONS.md)

- [ ] Rates, fees, taxes, minimum stay, check-in/out times
- [ ] Hold length while paying (default 30 minutes)
- [x] Owner approval of the /book sentence and the minimal /book/[ref]
      status page (docs/FRONTEND-CHANGES.md)
- [ ] Cancellation policy page text
- [ ] Owner-cancellation, no-show and amendment terms; booking terms;
      privacy notice; legal review (the 24-hour guest cancellation policy is
      confirmed and implemented)
- [ ] Whether to pause online booking while the Airbnb feed is stale
- [ ] Property facts confirmed (bed sizes, "waterfront" wording, amenities,
      house rules)
- [ ] Dedicated Supabase project (and approval of any cost)
- [ ] Stripe account choice and test keys; later, live-mode approval
- [ ] Resend account and verified sending domain; approval of email wording
- [ ] Scheduler choice and uptime monitor account
- [ ] Late-payment rule; whether Google Calendar is wanted

### Engineering

- [ ] Apply migrations to the dedicated Supabase dev project and run the app
      against it (`pnpm db:verify --migrate`, docs/SUPABASE-DEV-SETUP.md)
- [ ] Run the Stripe sandbox plan end to end and record the results
- [ ] Configure and verify the scheduler and uptime monitor (docs/SCHEDULER.md)
- [ ] Stripe reconciliation job (compare Stripe charges and refunds with
      our records)
- [ ] Error monitoring (e.g. Sentry) with PII scrubbing
- [ ] Data retention schedule and purge job
- [ ] Backups (PITR) and a tested restore; incident runbooks
- [ ] Public pages read confirmed facts from the database
- [ ] Google Calendar, if wanted
- [ ] Manual accessibility review on a deployed preview
- [ ] Decide whether to scrub an owner email address from the default
      branch's history (commit `c9f6d6d`; needs a history rewrite)

### Deployment (each needs explicit owner approval)

- [ ] Production database and controlled migration
- [ ] Secrets in the platform secret manager: `DATABASE_URL`,
      `DATABASE_URL_UNPOOLED`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`,
      `HEALTHCHECK_SECRET`, `GUEST_LINK_SECRET`, `CALENDAR_EXPORT_SECRET`,
      `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, email settings
- [ ] First owner account via `pnpm admin invite` (one-time link)
- [ ] Stripe webhook endpoint with the checkout and refund events
      (`checkout.session.*`, `refund.created`, `refund.updated`,
      `refund.failed`)
- [ ] Live mode (`STRIPE_LIVE_MODE_APPROVED=true`) and real email
      (`EMAIL_DELIVERY=resend`, `EMAIL_LIVE_DELIVERY_APPROVED=true`)
- [ ] Booking flow enabled on production (a code change, at launch only)
- [ ] `SITE_INDEXABLE=true`; owner acceptance testing; explicit launch
      approval
