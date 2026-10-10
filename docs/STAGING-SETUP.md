# Staging setup (customer demo)

Status: 10 October 2026. **Not set up.** No staging database, no Lodge
Stripe sandbox and no staging environment variables exist yet. This is the
recipe, with the decisions and access it needs from the owner. Nothing here
touches production (lsllodge.vercel.app), the other app's two Supabase
projects, or the other app's Stripe sandbox.

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

## 1. A database just for the Lodge (owner decision)

Supabase refused a third project on 10 October 2026: the owner's account is
at the free plan's limit of **2 active projects**, and both belong to
another app (not touched, and not to be paused or reused without the owner's
say-so).

| Option                                                                     | Cost                                                                                                                                                                 | Who acts                                                                                     | Notes                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Supabase under a separate account** (e.g. a Lodge business email)     | Free                                                                                                                                                                 | Owner creates the account, org and project `lodge-on-the-lake-staging` in London (eu-west-2) | **Recommended.** Fully isolated from the other app. Free projects pause after a week idle (resume in the dashboard before a demo); daily backups only. Same setup as [SUPABASE-DEV-SETUP.md](SUPABASE-DEV-SETUP.md). |
| **B. Neon free plan via the Vercel Marketplace** (Storage → Create → Neon) | Free (Neon's free plan: compute hours and ~0.5–1 GB storage per project; suspends rather than bills at the limit)                                                    | Owner approves creating the resource in the Vercel team                                      | Quickest. Plain PostgreSQL: create the `anon` and `authenticated` roles before migrating (see below). Not Supabase, so the RLS checks in `db:verify` test stand-in roles.                                            |
| C. Upgrade the FYStay Supabase organisation to Pro                         | From **$25/month per organisation**, plus compute per project (one Micro project is covered by the included $10 credit; each extra Micro project is about $10/month) | Owner (billing)                                                                              | Shares an organisation with the other app; keep the projects separate.                                                                                                                                               |
| D. Pause one of the other app's projects                                   | Free                                                                                                                                                                 | Owner only                                                                                   | **Not recommended**, and not done here: it changes another app.                                                                                                                                                      |

Whichever is chosen, the **owner** creates it and keeps the password in a
password manager. Never paste a connection string into chat, email or the
repository.

For option B only, before migrating, connect with the unpooled string and
run:

```sql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
```

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
| `DATABASE_URL`                                                                     | The staging database's pooled connection string                                                     |
| `DATABASE_URL_UNPOOLED`                                                            | Its direct/session string (migrations only)                                                         |
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

Run from a checkout of the branch, with the variables in your shell only
(not in a file in the repository):

```bash
export DATABASE_URL='<staging unpooled string>'   # migrations want unpooled
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
export DEMO_DATABASE_HOST='<that string's host>'    # confirms "this is the demo DB"
export SITE_URL='https://lsllodge-git-claude-instant-booking-fystay1.vercel.app'
export CREDENTIALS_ENCRYPTION_KEY='<same value as on Vercel>'

pnpm db:migrate                 # committed migrations, additive only
pnpm db:verify                  # RLS, roles, triggers and constraints
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

Vercel Cron runs on production deployments only, so staging has no timer.
**The demo doesn't need one:** an expired hold is treated as expired the
moment anyone looks at it, refunds are sent straight away when the owner
records a cancellation, and email is off. To run the jobs by hand, use
"Run now" in `/admin/system`. For a staging soak, either:

- Supabase `pg_cron` + `pg_net` calling `/api/jobs/tick` every 5 minutes
  with the cron secret and the bypass header (both from Supabase Vault), or
- an external scheduler that can send both headers.

## 7. Check it end to end

```bash
STAGING_E2E=true STAGING_STRIPE=true \
E2E_BASE_URL="$SITE_URL" \
DATABASE_URL='<staging string>' DEMO_DATABASE_HOST='<host>' \
VERCEL_AUTOMATION_BYPASS_SECRET='…' \
STRIPE_SECRET_KEY='sk_test_…' STRIPE_WEBHOOK_SECRET='whsec_…' \
pnpm test:e2e e2e/staging-journey.spec.ts --project desktop
```

Staging counts as demo-ready only when this passes in full. Then
`pnpm demo reset --yes` and record the result in
[STAGING-READINESS.md](STAGING-READINESS.md). The demo itself:
[DEMO.md](DEMO.md).
