/**
 * Verifies (and, only when asked, migrates) a Lodge on the Lake database.
 *
 *   pnpm db:verify                    # read-only checks
 *   LODGE_DB_CONFIRM_HOST=<host> pnpm db:verify --migrate
 *
 * Uses DATABASE_URL_UNPOOLED, else DATABASE_URL.
 *
 * Safety: it refuses to migrate a database that contains tables this app
 * doesn't own (another application's project), and refuses unless
 * LODGE_DB_CONFIRM_HOST equals the host it is connected to, so the operator
 * must positively name the target. It never drops or deletes anything.
 * Credentials are never printed.
 */
import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/server/db/schema";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL).");
  process.exit(1);
}
const wantMigrate = process.argv.includes("--migrate");
const host = new URL(url).hostname;

const ours = new Set(
  (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableConfig(t).name),
);
const journal = JSON.parse(
  readFileSync("./drizzle/meta/_journal.json", "utf8"),
) as {
  entries: { tag: string }[];
};

const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: false });
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
};

try {
  const [{ db, version }] = await sql`
    SELECT current_database() AS db, current_setting('server_version') AS version`;
  console.log(`Connected to ${host}, database "${db}", PostgreSQL ${version}.`);

  const present = (
    await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  ).map((r) => r.tablename as string);
  const foreign = present.filter((t) => !ours.has(t));
  check(
    "no tables from another application in public",
    foreign.length === 0,
    foreign.length
      ? `found ${foreign.slice(0, 8).join(", ")}${foreign.length > 8 ? ", …" : ""}`
      : "",
  );

  if (wantMigrate) {
    if (foreign.length > 0) {
      console.error(
        "\nRefusing to migrate: this database belongs to something else.",
      );
      process.exit(2);
    }
    if (process.env.LODGE_DB_CONFIRM_HOST !== host) {
      console.error(
        `\nRefusing to migrate: set LODGE_DB_CONFIRM_HOST=${host} to confirm this is the intended Lodge development database.`,
      );
      process.exit(2);
    }
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.\n");
  }

  const after = new Set(
    (
      await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    ).map((r) => r.tablename as string),
  );
  const missing = [...ours].filter((t) => !after.has(t));
  check(
    "every application table exists",
    missing.length === 0,
    missing.join(", "),
  );

  const applied =
    await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(
      () => [{ n: 0 }],
    );
  check(
    "all committed migrations applied",
    applied[0].n === journal.entries.length,
    `${applied[0].n} of ${journal.entries.length}`,
  );

  const [ext] =
    await sql`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'btree_gist'`;
  check("btree_gist extension installed", ext.n === 1);

  const [excl] = await sql`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conname = 'reservations_no_overlapping_active_stays' AND contype = 'x'`;
  check("overlap exclusion constraint present", excl.n === 1);

  const triggers = (
    await sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.reservations'::regclass AND NOT tgisinternal`.catch(
      () => [],
    )
  ).map((r) => r.tgname as string);
  for (const name of [
    "reservations_status_transition",
    "reservations_initial_status",
    "reservations_quote_immutable",
  ])
    check(`trigger ${name}`, triggers.includes(name));

  const [idx] = await sql`
    SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`;
  check("indexes present", idx.n >= 30, `${idx.n} indexes`);

  const noRls = (
    await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity`
  ).map((r) => r.tablename as string);
  check(
    "row level security enabled on every table",
    noRls.length === 0,
    noRls.join(", "),
  );

  for (const role of ["anon", "authenticated"]) {
    const [exists] =
      await sql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`;
    if (!exists.n) continue;
    const [grants] = await sql`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE grantee = ${role} AND table_schema = 'public'`;
    check(
      `Data API role "${role}" has no table privileges`,
      grants.n === 0,
      `${grants.n} grants`,
    );
  }
} finally {
  await sql.end();
}

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
