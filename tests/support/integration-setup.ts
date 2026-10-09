/**
 * Integration-test global setup: resets the disposable test database and
 * applies the committed migrations, exactly as production would.
 *
 * TEST_DATABASE_URL must point at a throwaway database. Its contents are
 * destroyed on every run.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a disposable PostgreSQL database.",
    );
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(
      "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
    );
    // Stand-ins for Supabase's Data API roles, so the RLS migration is
    // exercised as it would be on Supabase. Granted what Supabase grants by
    // default, before migrations run.
    await client.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
