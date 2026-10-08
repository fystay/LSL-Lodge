# Lodge on the Lake

Direct-booking website for Lodge on the Lake, a lakeside lodge at South
Lakeland Leisure Village. It runs alongside the existing Airbnb listing.

**Status:** Phases 0–1 (foundation and public site). Pre-launch preview only:
online booking is not open, no payments or emails are live, and the site is
`noindex`. Property content awaits owner confirmation.

- Project charter: [CLAUDE.md](CLAUDE.md)
- Plan, data model, payment and sync design: [docs/PLAN.md](docs/PLAN.md)
- Integration limits (Airbnb iCal, Google, Stripe): [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
- Owner inputs needed: [docs/OWNER-DECISIONS.md](docs/OWNER-DECISIONS.md)
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
    booking/           Reservation state machine (+ DB overlap tests)
    calendar/          iCal parsing, SSRF-safe fetch, import reconciliation
    contact/           Enquiry validation
    crypto/            Credential encryption
    db/                Drizzle schema and client
    notifications/     Email abstraction
    payments/          Stripe webhook verification
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
