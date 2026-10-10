-- One-time setup of the Lodge's staging database inside a Supabase project
-- that also holds another application's tables in `public`.
-- Run once as `postgres` (Supabase SQL editor). Idempotent.
--
-- Isolation:
-- - Every Lodge table, type, function and migration record lives in the
--   schema `lodge`, owned by the role `lodge_app`.
-- - The app and the migrations connect as `lodge_app`, whose search_path is
--   `lodge`. It gets no privileges on anything in `public`, so a Lodge bug
--   can't read or change the other application's data.
-- - `lodge` isn't exposed through Supabase's Data API (only schemas listed
--   in API settings are), and the migrations also revoke anon/authenticated.
--
-- After running this, set the role's password YOURSELF (never in chat or
-- in the repository):
--   ALTER ROLE lodge_app WITH PASSWORD '<generated in your password manager>';
-- Connection strings then use the user `lodge_app.<project ref>` on the
-- Supavisor pooler (transaction mode, port 6543, for DATABASE_URL; session
-- mode, port 5432, for DATABASE_URL_UNPOOLED), with DATABASE_SCHEMA=lodge.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lodge_app') THEN
    -- LOGIN, but no password yet: nobody can sign in as it until the owner
    -- sets one.
    CREATE ROLE lodge_app LOGIN NOINHERIT;
  END IF;
END $$;

-- Lets the administrator running this (`postgres` on Supabase) act as
-- lodge_app, so objects created on its behalf are owned by lodge_app.
GRANT lodge_app TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS lodge AUTHORIZATION lodge_app;
-- The migrator always runs CREATE SCHEMA IF NOT EXISTS, which PostgreSQL
-- checks against the database even when the schema exists. This lets
-- lodge_app create schemas; it still has nothing in `public`.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO lodge_app', current_database());
END $$;
ALTER ROLE lodge_app SET search_path = lodge;
-- Statement timeout so a runaway query can't hold the shared database.
ALTER ROLE lodge_app SET statement_timeout = '30s';

-- The overlap constraint needs btree_gist. Supabase keeps extensions in the
-- `extensions` schema; default operator classes are found by type, so the
-- Lodge schema doesn't need it on its search_path.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- Nothing in `public` for lodge_app (PostgreSQL 15+ already denies CREATE
-- there to ordinary roles).
REVOKE ALL ON SCHEMA public FROM lodge_app;
