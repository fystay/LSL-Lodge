/**
 * Schema isolation for a database shared with another application (the
 * Lodge's staging database lives in a Supabase project whose `public`
 * schema belongs to someone else). Used by scripts/migrate.mts,
 * scripts/db-verify.mts and scripts/staging-preflight.mts.
 *
 * Two independent barriers:
 * 1. Text: the committed migrations' explicit `public` references are
 *    rewritten to the Lodge schema, and anything left over is refused.
 * 2. Privilege: isolated migrations only run as a restricted role whose
 *    search_path is the Lodge schema and which can neither create in nor
 *    touch anything in `public`. Even a migration bug can't reach the other
 *    application's tables, data, RLS policies or grants.
 *
 * No `server-only` import: scripts run outside Next.js.
 */
import type { Sql, TransactionSql } from "postgres";

/** Environment variables (process.env or a subset of it). */
export type Env = Record<string, string | undefined>;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** The Lodge schema: `public` unless DATABASE_SCHEMA names another. */
export function targetSchema(env: Env = process.env): string {
  const schema = env.DATABASE_SCHEMA?.trim() || "public";
  if (!IDENTIFIER.test(schema))
    throw new Error("DATABASE_SCHEMA must be a plain lower-case identifier.");
  return schema;
}

/** Rewrites a migration's explicit `public` references to the target schema. */
export function toSchema(query: string, schema: string): string {
  if (!IDENTIFIER.test(schema) || schema === "public")
    throw new Error(`Not an isolated schema: "${schema}".`);
  const out = query
    .replaceAll('"public".', `"${schema}".`)
    .replaceAll("schemaname = 'public'", `schemaname = '${schema}'`)
    .replaceAll("public.%I", `${schema}.%I`)
    .replaceAll("IN SCHEMA public", `IN SCHEMA ${schema}`);
  const code = out
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  if (/\bpublic\s*\.|"public"|\bSCHEMA\s+public\b|'public'/i.test(code))
    throw new Error(
      "A migration still refers to the public schema after rewriting; refusing.",
    );
  return out;
}

/** Functions created by the migrations resolve names in the Lodge schema only. */
export function pinFunctionsSql(schema: string): string {
  if (!IDENTIFIER.test(schema)) throw new Error("Bad schema name.");
  return `
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${schema}'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = ${schema}, pg_catalog', f);
  END LOOP;
END $$;`;
}

export interface IsolationState {
  role: string;
  currentSchema: string | null;
  superuser: boolean;
  bypassRls: boolean;
  canCreateInPublic: boolean;
  /** Relations in `public` this role can read or change in any way. */
  publicRelationsReachable: number;
  /** Objects in `public` this role owns (it could alter them). */
  publicObjectsOwned: number;
}

export async function isolationState(
  sql: Sql | TransactionSql,
): Promise<IsolationState> {
  const [row] = await sql`
    SELECT
      current_user AS role,
      current_schema() AS current_schema,
      r.rolsuper AS superuser,
      r.rolbypassrls AS bypass_rls,
      has_schema_privilege('public', 'CREATE') AS can_create_in_public,
      (SELECT count(*)::int FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(c.oid,
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
        AS public_relations_reachable,
      (SELECT count(*)::int FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relowner = r.oid)
      + (SELECT count(*)::int FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proowner = r.oid)
      + (SELECT count(*)::int FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typowner = r.oid AND t.typtype = 'e')
        AS public_objects_owned
    FROM pg_roles r WHERE r.rolname = current_user`;
  return {
    role: row.role,
    currentSchema: row.current_schema,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    canCreateInPublic: row.can_create_in_public,
    publicRelationsReachable: row.public_relations_reachable,
    publicObjectsOwned: row.public_objects_owned,
  };
}

/** Why this connection must not be used for the isolated Lodge schema. */
export function isolationProblems(
  state: IsolationState,
  schema: string,
): string[] {
  const problems: string[] = [];
  if (state.currentSchema !== schema)
    problems.push(
      `the connection resolves names in "${state.currentSchema ?? "(none)"}", not "${schema}" (connect as the Lodge role, whose search_path is ${schema})`,
    );
  if (state.superuser) problems.push(`role "${state.role}" is a superuser`);
  if (state.bypassRls)
    problems.push(`role "${state.role}" bypasses row level security`);
  if (state.canCreateInPublic)
    problems.push(`role "${state.role}" can create objects in public`);
  if (state.publicRelationsReachable > 0)
    problems.push(
      `role "${state.role}" has privileges on ${state.publicRelationsReachable} relation(s) in public`,
    );
  if (state.publicObjectsOwned > 0)
    problems.push(
      `role "${state.role}" owns ${state.publicObjectsOwned} object(s) in public`,
    );
  return problems;
}
