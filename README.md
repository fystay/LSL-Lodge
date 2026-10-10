# Lodge on the Lake

Direct-booking website for Lodge on the Lake, a lakeside lodge at South
Lakeland Leisure Village. It runs alongside the existing Airbnb listing.

**Status:** pre-launch. Built: public site, instant-booking engine, owner
dashboard, test-mode Stripe Checkout, email notifications
(off by default) and Airbnb iCal sync. No payments or emails are live, the
booking flow is off unless explicitly enabled outside production, and the
site is `noindex`. Property facts, prices and policies await the owner. See
docs/PLAN.md §7 for what is still open and
[docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) for the launch
checklist.

How booking works (instant booking, no host approval): the guest picks
available dates and enters their details → the dates are held for 30
minutes while they pay the full amount on Stripe-hosted Checkout → the
booking confirms only when the server has verified the payment (signed
webhook, or a server-side fetch of the session). Guests can cancel for a full
refund strictly within 24 hours of the booking being confirmed (the clock
starts at verified payment); after that the booking is non-refundable
(src/server/booking/cancellation-policy.ts). The production UI
(lsllodge.vercel.app) is the reference for the public site; see
docs/FRONTEND-CHANGES.md and docs/VISUAL-REGRESSION.md. The owner blocks
and unblocks dates in `/admin/blocks`.

- Project charter: [CLAUDE.md](CLAUDE.md)
- Plan, data model, payment and sync design: [docs/PLAN.md](docs/PLAN.md)
- Integration limits (Airbnb iCal, Google, Stripe): [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
- Owner inputs needed: [docs/OWNER-DECISIONS.md](docs/OWNER-DECISIONS.md)
- Property facts and their sources: [docs/property-facts-and-policies.md](docs/property-facts-and-policies.md)
- Launch checklist: [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)
- Staging setup and customer demo: [docs/STAGING-SETUP.md](docs/STAGING-SETUP.md), [docs/DEMO.md](docs/DEMO.md)
- Content and photography: [docs/CONTENT.md](docs/CONTENT.md)
- Security notes: [docs/SECURITY.md](docs/SECURITY.md)

## Stack

Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind
CSS 4 · PostgreSQL 16 with Drizzle ORM · Stripe Checkout · Vitest ·
Playwright + axe-core. pnpm 10 and Node 22.

## Getting started

```bash
pnpm install
cp .env.example .env.local      # fill in what you need; leave secrets out of git
pnpm dev                        # http://localhost:3000
```

The public site runs without a database or any integration configured.

### Database

You need PostgreSQL 16 or later with the `btree_gist` extension available
(Supabase and Neon both provide it).

```bash
# Local example
createdb lodge_dev
DATABASE_URL=postgres://user:pass@localhost:5432/lodge_dev pnpm db:migrate
```

- Change `src/server/db/schema.ts`, then run `pnpm db:generate` and commit the
  generated SQL.
- Constraints drizzle-kit can't express go in custom migrations
  (`pnpm drizzle-kit generate --custom --name <name>`); see
  `drizzle/0001_overlap_protection.sql`.
- Migrations run as an explicit deployment step (`pnpm db:migrate` with
  `DATABASE_URL_UNPOOLED`), never on app start.

### Trying the booking flow and admin locally

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/lodge_dev
pnpm db:migrate
pnpm db:seed:dev            # placeholder property, rates and payment plan (local only)

# In .env.local (never commit real values):
#   BOOKING_PREVIEW=true
#   CREDENTIALS_ENCRYPTION_KEY=<openssl rand -base64 32>
#   CREDENTIALS_ENCRYPTION_KEY_VERSION=1
pnpm dev                    # /availability for guests, /admin for the owner
pnpm admin invite --email you@example.com   # prints a one-time set-up link
```

The seed's prices are made up. Real rates are entered by the owner in
`/admin/pricing`. Admin accounts need an authenticator app; see
docs/SECURITY.md ("Admin authentication") and `scripts/admin.mts`.

To try the full journey: choose dates at `/availability` and continue to
payment. Without Stripe keys you land on the booking page, which holds the
dates and says payment isn't switched on. To pay
in test mode, add `STRIPE_SECRET_KEY=sk_test_…` and run `stripe listen` (see
docs/INTEGRATIONS.md). Messages are recorded as "not sent" and can be
previewed on the booking's admin page. Optional extras: `GUEST_LINK_SECRET`
(links in emails), `CALENDAR_EXPORT_SECRET` (export feed) and
`CREDENTIALS_ENCRYPTION_KEY` (needed to add an Airbnb link).

### Scheduled jobs

A scheduler must call `GET /api/jobs/tick` every 5 minutes with
`Authorization: Bearer $CRON_SECRET`; it runs hold expiry, email
delivery, refund sending and retries, Airbnb sync and housekeeping, each under a lease so runs never
overlap. An uptime monitor should call `/api/health` (with
`HEALTHCHECK_SECRET`). **No scheduler is configured yet**; see
[docs/SCHEDULER.md](docs/SCHEDULER.md). `/admin/system` shows every run and
has "Run now".

Stripe calls `/api/webhooks/stripe` (signature-verified).

To run the booking and admin E2E tests too:
`E2E_BOOKING=true` and `RATE_LIMIT_SCALE=50` plus the variables above, then
`pnpm build && pnpm test:e2e`.

## Scripts

| Command                        | Purpose                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pnpm dev` / `build` / `start` | Develop, build, serve production build                                                                       |
| `pnpm format` / `format:check` | Prettier                                                                                                     |
| `pnpm lint`                    | ESLint                                                                                                       |
| `pnpm typecheck`               | Route type generation + `tsc`                                                                                |
| `pnpm test`                    | Unit tests                                                                                                   |
| `pnpm test:integration`        | PostgreSQL integration tests. Needs `TEST_DATABASE_URL` pointing at a **disposable** database (it is wiped). |
| `pnpm test:e2e`                | Playwright E2E and axe accessibility tests against the production build (`pnpm build` first)                 |
| `pnpm check`                   | Format, lint, types and unit tests                                                                           |
| `pnpm db:seed:dev`             | Placeholder data for a **local** database (refuses any other host)                                           |
| `pnpm admin <command>`         | Admin accounts: `invite`, `reset`, `disable`, `enable`, `list`                                               |

CI (`.github/workflows/ci.yml`) runs all of the above, plus a production
build, a dependency audit and integration tests against a Postgres service
container.

## Layout

```
src/
  app/                 Routes (public pages, sitemap, robots)
  components/          Owned UI primitives: header, footer, gallery, search form
  content/             Property facts (with verification status) and photo manifest
  lib/                 Shared, framework-free logic: dates, time zones, search validation
  server/              Server-only domain code
    admin/             Admin auth, validation schemas, queries and audited mutations
    booking/           State machine, availability, holds, owner blocks, cancellation policy, guest links
    jobs/              Scheduler authentication
    calendar/          iCal parsing, SSRF-safe fetch, import sync, export feed
    contact/           Enquiry validation
    crypto/            Credential encryption
    db/                Drizzle schema and client
    notifications/     Outbox, templates, Resend adapter, dispatcher
    payments/          Checkout gateway, payment lifecycle, webhook processing
    security/          Rate limiting
    pricing/           Quote engine and rule loading
drizzle/               Committed SQL migrations
e2e/                   Playwright tests
docs/                  Plan and operational documentation
```

## Conventions

- Stay dates are property-local calendar dates (`YYYY-MM-DD`, time zone
  `Europe/London`) with `[check-in, check-out)` semantics. Timestamps are UTC.
- Money is integer pence.
- Client code is never trusted for price, availability, payment or booking
  state.
- Facts not confirmed by the owner must stay marked as such in
  `src/content/property.ts`.
