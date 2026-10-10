# Staging setup (customer demo)

Status: 10 October 2026. **Partly set up.** The Lodge's staging database
now lives in the owner-authorised Supabase project `lsllodge`
(`sqkpixwvugrxllrxlexs`), isolated in its own schema (§1); migrations
0000–0001 are applied there, 0002–0010 are waiting for you (§5). There is
still no Lodge Stripe sandbox and no staging environment variables on
Vercel. Nothing here touches production (lsllodge.vercel.app), the other
application's tables in that project, or the other app's Stripe sandbox.

## What "staging" is

The Vercel **Preview** deployment of the branch `claude/instant-booking`, at
its stable branch address:

    https://lsllodge-git-claude-instant-booking-fystay1.vercel.app

(Vercel builds it on every push to the branch; confirm the exact address on
the project's Deployments page.) It is a separate environment from
production by design:

- The booking engine **refuses to run on Vercel production**
  (`VERCEL_ENV=production`) whatever the variables say, so a staging
  configuration can't switch on bookings on the live site.
- Variables are added to the **Preview** environment **for this branch
  only**, so other previews and production get none of them.
- Stripe is in **test mode** only (`sk_test_…`); the app refuses live keys
  unless `STRIPE_LIVE_MODE_APPROVED=true`, which staging never sets.
- Email delivery stays **off**: messages are recorded and previewed in
  `/admin`, never sent.
- Search engines are told not to index it (`SITE_INDEXABLE` unset).

## 1. The database: `lsllodge`, schema `lodge`

The project you authorised for Lodge staging still holds **another
application's live-looking data** in `public` (47 tables, e.g. `User`,
`Booking`, `_prisma_migrations`). The Lodge's committed migrations would
have re-permissioned every table in `public` (migration 0005 enables RLS on
and revokes Data API access from all of them), so they are never run there.
Instead:

- Every Lodge object lives in the schema **`lodge`**, owned by the role
  **`lodge_app`** ([scripts/staging-database.sql](../scripts/staging-database.sql),
  applied 10 October 2026). `lodge_app` has `search_path = lodge`, no
  privileges on anything in `public`, and a 30 s statement timeout.
- `pnpm db:migrate` with `DATABASE_SCHEMA=lodge` rewrites the migrations'
  explicit `public` references to `lodge`, refuses to run unless the
  connection resolves names in `lodge`, and pins every Lodge function's
  `search_path`. `public` is never touched; rehearsed locally against a
  copy with a stand-in "other app" table (its rows, RLS and grants
  unchanged after migrations and the full E2E suite).
- `lodge` isn't exposed through Supabase's Data API (only the schemas in
  API settings are), and the migrations revoke `anon`/`authenticated`
  anyway.

Applied so far (via the Supabase connector): the setup script, and
migrations 0000–0001. The rest stopped because the connector asks for a
person's confirmation before any statement containing `DROP` (migrations
0002, 0008 and 0009 replace triggers and types), which this session can't
give. Nothing was half-applied: each step is one transaction.

## 2. A Stripe sandbox just for the Lodge (owner)

The existing "FYStay sandbox" belongs to another app (its webhooks go to
that app) and **must not be used**.

1. In the Stripe Dashboard, account switcher → **Sandboxes → Create
   sandbox**, name it "Lodge on the Lake staging". Sandboxes are free.
2. In that sandbox: Developers → API keys. Keep the secret key private.
3. Settings → Payments: card payments on. Adaptive Pricing makes no
   difference (the app turns it off per session).

## 3. Preview variables for this branch (owner, or a developer with access)

Vercel → project `lsllodge` → Settings → Environment Variables → Add, with
**Environment: Preview** and **Branch: `claude/instant-booking`**. Mark the
secrets as Sensitive.

| Variable                                                                           | Value                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                     | `lodge_app` transaction-mode (port 6543) string (§5)                                                |
| `DATABASE_SCHEMA`                                                                  | `lodge`                                                                                             |
| `DATABASE_URL_UNPOOLED`                                                            | `lodge_app` session-mode (port 5432) string (migrations only)                                       |
| `SITE_URL`                                                                         | The branch address above (no trailing slash): Stripe returns guests here                            |
| `BOOKING_PREVIEW`                                                                  | `true`                                                                                              |
| `PROPERTY_SLUG`                                                                    | `lodge-on-the-lake`                                                                                 |
| `PROPERTY_TIME_ZONE`                                                               | `Europe/London`                                                                                     |
| `GUEST_LINK_SECRET`, `CALENDAR_EXPORT_SECRET`, `CRON_SECRET`, `HEALTHCHECK_SECRET` | Each a new random value: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CREDENTIALS_ENCRYPTION_KEY`                                                       | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                       |
| `CREDENTIALS_ENCRYPTION_KEY_VERSION`                                               | `1`                                                                                                 |
| `STRIPE_SECRET_KEY`                                                                | The Lodge sandbox's `sk_test_…`                                                                     |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`                                               | The Lodge sandbox's `pk_test_…`                                                                     |
| `STRIPE_WEBHOOK_SECRET`                                                            | From step 5                                                                                         |
| `EMAIL_DELIVERY`                                                                   | `off`                                                                                               |

Never set `STRIPE_LIVE_MODE_APPROVED`, `EMAIL_LIVE_DELIVERY_APPROVED` or
`SITE_INDEXABLE` on staging. Then redeploy the branch (Deployments → the
branch's latest → Redeploy) so the variables apply.

## 4. Deployment protection and sharing (owner)

Previews are behind Vercel Authentication. Keep it on.

- **For automated tests and Stripe's webhooks:** Settings → Deployment
  Protection → **Protection Bypass for Automation** → generate a secret.
  Keep it as `VERCEL_AUTOMATION_BYPASS_SECRET` on your own machine only.
- **For showing a customer:** open the branch deployment and use Vercel's
  **Share** option to create a link that lets them in without a Vercel
  account (check it's available on your plan; otherwise sign the customer in
  as a team viewer or present from your own screen).

## 5. Database, demo data, owner account and webhook (operator's machine)

1. In the Supabase dashboard (project `lsllodge`) → SQL editor, give the
   Lodge role a password **you** generate (never in chat or git):

   ```sql
   ALTER ROLE lodge_app WITH PASSWORD '<from your password manager>';
   ```

2. Connection strings use the user `lodge_app.sqkpixwvugrxllrxlexs` on the
   Supavisor pooler shown in Connect: **session mode, port 5432** for
   migrations and these commands; **transaction mode, port 6543** for the
   app's `DATABASE_URL` on Vercel.

Run from a checkout of the branch, with the variables in your shell only
(not in a file in the repository):

```bash
export DATABASE_SCHEMA=lodge
export DATABASE_URL='<lodge_app session-mode string>'
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
export DEMO_DATABASE_HOST='<that string's host>'    # confirms "this is the demo DB"
export SITE_URL='https://lsllodge-git-claude-instant-booking-fystay1.vercel.app'
export CREDENTIALS_ENCRYPTION_KEY='<same value as on Vercel>'

pnpm db:migrate                 # applies 0002–0010 in schema lodge
pnpm db:verify                  # RLS, roles, triggers and constraints (in lodge)
pnpm demo seed                  # placeholder property, prices and payment plan;
                                # marks the database as a demo database
pnpm admin invite --email <owner's email>   # prints a one-time set-up link
```

Open the set-up link, choose a password and add the authenticator app. Then
in `/admin/settings`, confirm online booking is on.

Stripe webhook (test mode, Lodge sandbox only):

```bash
STRIPE_SECRET_KEY='sk_test_…' \
STAGING_URL="$SITE_URL" \
VERCEL_AUTOMATION_BYPASS_SECRET='…' \
pnpm stripe:test-setup --account acct_<Lodge sandbox id>          # dry run
#  …then the same with --apply
```

The script refuses live keys, a key from any other account than the one you
name, and an account that already sends webhooks to other sites (the sign
of a shared sandbox). It creates one endpoint (API version
`2026-09-30.endive`) for the checkout and refund events and prints the
signing secret once, to your terminal only. Put it in Vercel as
`STRIPE_WEBHOOK_SECRET` (step 3) and redeploy.

## 6. Scheduled jobs on staging

Vercel Cron runs on production deployments only (and only daily on the free
Hobby plan), so staging uses **Supabase `pg_cron` + `pg_net`** (free):
[scripts/staging-scheduler.sql](../scripts/staging-scheduler.sql) calls
`/api/jobs/tick` every 5 minutes with the cron secret and the Vercel bypass
header, both read from Supabase Vault (you store them; the file has no
secrets). Jobs: expire holds, send notifications, process refunds,
**reconcile payments with Stripe** (catches missed webhooks), sync
calendars, maintenance, **data retention**. Check runs in `/admin/system`.

The demo doesn't depend on it: an expired hold is treated as expired the
moment anyone looks at it, and refunds are sent straight away when the
owner records a cancellation.

## 7. Check it end to end

```bash
STAGING_E2E=true STAGING_STRIPE=true \
E2E_BASE_URL="$SITE_URL" \
DATABASE_SCHEMA=lodge DATABASE_URL='<lodge_app session string>' DEMO_DATABASE_HOST='<host>' \
VERCEL_AUTOMATION_BYPASS_SECRET='…' \
STRIPE_SECRET_KEY='sk_test_…' STRIPE_WEBHOOK_SECRET='whsec_…' \
pnpm test:e2e e2e/staging-journey.spec.ts --project desktop
```

Staging counts as demo-ready only when this passes in full. Then
`pnpm demo reset --yes` and record the result in
[STAGING-READINESS.md](STAGING-READINESS.md). The demo itself:
[DEMO.md](DEMO.md).
