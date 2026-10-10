/**
 * Applying the Lodge migrations to the shared staging database through an
 * SQL executor (Supabase's Management API in scripts/hosted-migrate.mts; a
 * local connection in tests). Used where no direct Postgres connection is
 * possible.
 *
 * Guarantees:
 * - Only migrations missing from the Lodge journal are applied, in order,
 *   each in ONE transaction together with its journal row: a failure or a
 *   lost response leaves either all of it or none of it. Nothing is ever
 *   retried automatically; re-planning reads the journal again.
 * - Every migration runs as the Lodge role inside the Lodge schema (SET
 *   LOCAL ROLE / search_path), verified inside the transaction before any
 *   statement runs, with the `public` references rewritten (toSchema).
 * - `public` is compared before and after by a catalog-only fingerprint
 *   (relations, columns, RLS flags, policies, grants, functions, triggers,
 *   types, default privileges). No row of the other application's data is
 *   read.
 *
 * No `server-only` import: runs from a script.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinFunctionsSql, toSchema } from "./isolation";

/** Runs one SQL string; returns the rows of its last statement. */
export type Executor = (query: string) => Promise<Record<string, unknown>[]>;

export interface Migration {
  tag: string;
  when: number;
  sql: string;
  hash: string;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function loadMigrations(
  schema: string,
  folder = "./drizzle",
): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { when: number; tag: string }[] };
  return journal.entries.map((e) => {
    const sql = toSchema(
      readFileSync(join(folder, `${e.tag}.sql`), "utf8"),
      schema,
    );
    return {
      tag: e.tag,
      when: e.when,
      sql,
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

/** The Lodge journal (created_at of each applied migration), oldest first. */
export async function appliedMigrations(
  exec: Executor,
  schema: string,
): Promise<number[]> {
  const [exists] = await exec(
    `SELECT to_regclass('"${schema}"."__drizzle_migrations"') IS NOT NULL AS present`,
  );
  if (!exists?.present) return [];
  const rows = await exec(
    `SELECT created_at::text AS created_at FROM "${schema}"."__drizzle_migrations" ORDER BY id`,
  );
  return rows.map((r) => Number(r.created_at));
}

/** Catalog-only fingerprint of `public`: no data rows are read. */
export const PUBLIC_FINGERPRINT_SQL = `
SELECT md5(coalesce((SELECT string_agg(x, '|' ORDER BY x) FROM (
  SELECT 'rel:' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity
         || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, '') AS x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
         || ':' || a.attnotnull || ':' || coalesce(a.attacl::text, '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT 'pol:' || p.tablename || ':' || p.policyname || ':' || p.cmd || ':' || array_to_string(p.roles, ',')
         || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '')
    FROM pg_policies p WHERE p.schemaname = 'public'
  UNION ALL SELECT 'con:' || c.relname || '.' || k.conname || ':' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  UNION ALL SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
         || pg_get_userbyid(p.proowner) || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'trg:' || c.relname || '.' || t.tgname || ':' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL SELECT 'type:' || t.typname || ':' || pg_get_userbyid(t.typowner) || ':'
         || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'nsp:' || pg_get_userbyid(nspowner) || ':' || coalesce(nspacl::text, '')
    FROM pg_namespace WHERE nspname = 'public'
  UNION ALL SELECT 'defacl:' || pg_get_userbyid(a.defaclrole) || ':' || a.defaclobjtype::text || ':' || a.defaclacl::text
    FROM pg_default_acl a JOIN pg_namespace n ON n.oid = a.defaclnamespace WHERE n.nspname = 'public'
) s), '')) AS fingerprint`;

export async function publicFingerprint(exec: Executor): Promise<string> {
  const [row] = await exec(PUBLIC_FINGERPRINT_SQL);
  return String(row.fingerprint);
}

/** Preconditions on the target database, checked before anything changes. */
export async function preconditions(
  exec: Executor,
  schema: string,
  role: string,
): Promise<string[]> {
  const [exists] = await exec(
    `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${role}'`,
  );
  if (!Number(exists?.n))
    return [`role ${role} doesn't exist (run scripts/staging-database.sql)`];
  const [row] = await exec(`
    SELECT
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = '${role}') AS role_privileged,
      (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '${schema}') AS schema_owner,
      pg_has_role(current_user, '${role}', 'SET') AS can_set_role,
      (SELECT count(*)::int FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist,
      (SELECT array_to_string(rolconfig, ',') FROM pg_roles WHERE rolname = '${role}') AS role_config`);
  const problems: string[] = [];
  if (row.role_privileged)
    problems.push(`role ${role} is superuser or bypasses RLS`);
  if (row.schema_owner !== role)
    problems.push(`schema ${schema} must exist and be owned by ${role}`);
  if (!row.can_set_role)
    problems.push(`the executing user can't SET ROLE ${role}`);
  if (!row.btree_gist) problems.push("extension btree_gist isn't installed");
  if (!String(row.role_config ?? "").includes(`search_path=${schema}`))
    problems.push(`role ${role} must have search_path=${schema}`);
  return problems;
}

/** One migration, its guard and its journal row, as a single transaction. */
export function migrationTransaction(
  m: Migration,
  schema: string,
  role: string,
): string {
  if (!IDENT.test(schema) || !IDENT.test(role))
    throw new Error("Bad identifier.");
  return [
    "BEGIN;",
    `SET LOCAL ROLE ${role};`,
    `SET LOCAL search_path TO ${schema};`,
    `DO $guard$ BEGIN
       IF current_user <> '${role}' OR current_schema() IS DISTINCT FROM '${schema}' THEN
         RAISE EXCEPTION 'not running as ${role} in schema ${schema}';
       END IF;
       IF EXISTS (SELECT 1 FROM "${schema}"."__drizzle_migrations" WHERE created_at >= ${m.when}) THEN
         RAISE EXCEPTION 'already applied: ${m.tag}';
       END IF;
     END $guard$;`,
    m.sql.replaceAll("--> statement-breakpoint", ""),
    `INSERT INTO "${schema}"."__drizzle_migrations" (hash, created_at) VALUES ('${m.hash}', ${m.when});`,
    "COMMIT;",
  ].join("\n");
}

export function journalTableTransaction(schema: string, role: string): string {
  return `BEGIN; SET LOCAL ROLE ${role};
CREATE TABLE IF NOT EXISTS "${schema}"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
COMMIT;`;
}

export function pinFunctionsTransaction(schema: string, role: string): string {
  return `BEGIN; SET LOCAL ROLE ${role};${pinFunctionsSql(schema)}
COMMIT;`;
}

export interface Plan {
  applied: string[];
  pending: Migration[];
  /** Journal rows that match no committed migration (refuse to continue). */
  unknown: number[];
}

export async function plan(
  exec: Executor,
  schema: string,
  migrations: Migration[],
): Promise<Plan> {
  const journal = await appliedMigrations(exec, schema);
  const known = new Set(migrations.map((m) => m.when));
  const last = journal.length ? Math.max(...journal) : -Infinity;
  return {
    applied: migrations
      .filter((m) => journal.includes(m.when))
      .map((m) => m.tag),
    // Same rule as drizzle's migrator: anything newer than the last applied.
    pending: migrations.filter((m) => m.when > last),
    unknown: journal.filter((w) => !known.has(w)),
  };
}

export type ApplyResult =
  | { ok: true; applied: string[] }
  | { ok: false; applied: string[]; failedAt: string; reason: string };

/**
 * Applies the pending migrations one transaction at a time. Stops at the
 * first error or uncertain outcome (e.g. a timeout) without retrying; the
 * journal shows afterwards whether that transaction committed.
 */
export async function applyPending(
  exec: Executor,
  schema: string,
  role: string,
  pending: Migration[],
  onProgress: (message: string) => void = () => {},
): Promise<ApplyResult> {
  const applied: string[] = [];
  await exec(journalTableTransaction(schema, role));
  for (const m of pending) {
    try {
      await exec(migrationTransaction(m, schema, role));
    } catch (error) {
      // Leave no aborted transaction behind on a reused connection. The
      // migration itself is atomic: nothing of it remains.
      await exec("ROLLBACK").catch(() => {});
      return {
        ok: false,
        applied,
        failedAt: m.tag,
        reason: (error as Error).message,
      };
    }
    applied.push(m.tag);
    onProgress(`applied ${m.tag}`);
  }
  await exec(pinFunctionsTransaction(schema, role));
  return { ok: true, applied };
}
