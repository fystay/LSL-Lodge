# Setting up a dedicated Supabase development project

Status (9 October 2026): **not created.** The connected Supabase account has
two projects, both holding another application's tables and data (for
example `Booking`, `User`, `_prisma_migrations`). Neither may be used for
Lodge on the Lake, and nothing has been run against them.

**Tried 10 October 2026:** creating `lodge-on-the-lake-dev` (eu-west-2) in
the FYStay organisation was refused by Supabase: the owner account has
reached the free plan's limit of 2 active projects. To proceed, the owner
chooses one of: upgrade the organisation (a cost), pause or delete one of
the other app's projects (their decision; not done here), or create a
separate organisation under another account. Until then, development and
tests run against local PostgreSQL 16 with Supabase's `anon` and
`authenticated` roles reproduced (see `tests/support/integration-setup.ts`);
Supabase runs PostgreSQL 17, and nothing used is version-specific.

## 1. Create the project (owner, in the Supabase dashboard)

1. Choose the organisation, or create a new one for the business so the
   Lodge is separate from other work.
2. **New project**:
   - Name: `lodge-on-the-lake-dev` (a later production project would be
     `lodge-on-the-lake-prod`; never share one between them).
   - Region: **West EU (London), eu-west-2**, keeping guest data in the UK.
   - Database password: let Supabase generate it and save it in a password
     manager. **Don't paste it into chat, email, tickets or the repository.**
3. Optional but recommended: Project Settings → API (Data API) → disable the
   Data API. This app never uses it (it connects server-side). Row Level
   Security already denies it everything (migration 0005).

## 2. Configure connection strings (owner or developer, privately)

In the project's **Connect** panel:

| Variable                | Use                     | Which string                                    |
| ----------------------- | ----------------------- | ----------------------------------------------- |
| `DATABASE_URL`          | The running app         | Transaction pooler (port 6543)                  |
| `DATABASE_URL_UNPOOLED` | Migrations, `db:verify` | Session pooler or direct connection (port 5432) |

Put them in `.env.local` (never committed) and, for a deployed preview, the
hosting provider's environment settings scoped to **Preview/Development
only**, never Production. The app already disables prepared statements for
the transaction pooler.

Also set `CREDENTIALS_ENCRYPTION_KEY` (32 random bytes, base64:
`openssl rand -base64 32`) and `CREDENTIALS_ENCRYPTION_KEY_VERSION=1`. Admin
sign-in and calendar links need it.

## 3. Verify the target, then migrate

```bash
pnpm db:verify
```

Expected on a brand-new project: it connects, reports the Supabase host
(`aws-…pooler.supabase.com` or `db.<project-ref>.supabase.co`), finds **no
tables from another application**, and reports the Lodge tables as missing.
**Stop if it lists tables such as `Booking`, `User` or `_prisma_migrations`:
you are connected to the wrong project.**

Then, naming the host you just saw:

```bash
LODGE_DB_CONFIRM_HOST=<host printed above> pnpm db:verify --migrate
```

The script refuses if the database holds another application's tables or if
the confirmed host doesn't match. It applies the committed migrations with
Drizzle's migrator (the same as `pnpm db:migrate`), then checks:

- every application table exists and all migrations are recorded;
- `btree_gist` is installed and the overlap exclusion constraint exists;
- the status-transition, initial-status and quote-immutability triggers;
- indexes;
- Row Level Security is on for every table, and Supabase's `anon` and
  `authenticated` roles have no table privileges.

It never drops, truncates or deletes anything.

## 4. First admin account

```bash
SITE_URL=<the preview URL> pnpm admin invite --email <owner's email>
```

Send the printed one-time link to the owner privately; it expires in 24
hours. They choose their password and set up an authenticator app.

## 5. Test the app against it

- `BOOKING_PREVIEW=true pnpm dev` (or a preview deployment with the same
  variables). Enter placeholder rates in `/admin/pricing`; the seed script
  deliberately refuses non-local databases.
- The automated integration tests **wipe their database**: never point
  `TEST_DATABASE_URL` at the Supabase project. Use local PostgreSQL or a
  separate throwaway database.

## 6. Letting Claude work with it

Connect the Supabase connector to the new project (or share the project
ref, never a password). Before any change, Claude will list the project's
tables and confirm it holds no other application's data. Migrations are
applied only through `pnpm db:verify --migrate` from an environment that has
the connection string, so they are recorded the same way everywhere.

## Notes

- Supabase runs PostgreSQL 17; the app has been tested on 16. Nothing used is
  version-specific, but `pnpm db:verify` and a run of the app must pass on
  the project before relying on it.
- Backups: enable Point-in-Time Recovery on the production project (paid
  add-on) and test a restore before launch.
