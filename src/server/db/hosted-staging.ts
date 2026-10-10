/**
 * Demo data and the owner's set-up link for the shared staging database,
 * as single SQL transactions for an executor with no direct Postgres
 * connection (Supabase's Management API in scripts/hosted-staging.mts).
 *
 * They do what `pnpm demo seed` and `pnpm admin invite` do over a direct
 * connection, with the same values and refusals:
 * - everything runs as the Lodge role inside the Lodge schema (SET LOCAL
 *   ROLE / search_path), checked inside the transaction first;
 * - seeding refuses a database holding non-demo bookings, and is idempotent;
 * - an invitation stores only the token's SHA-256, revokes the account's
 *   open sessions and is audit-logged. The token itself is returned to the
 *   caller and never sent to the database.
 *
 * No `server-only` import: runs from a script.
 */
import { randomToken, sha256 } from "../admin/credentials";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** Same lifetime as ENROLMENT_HOURS in src/server/admin/accounts.ts. */
export const HOSTED_ENROLMENT_HOURS = 24;
/** Bookings with these guest-email domains are demo bookings. */
export const DEMO_DOMAINS = ["example.test", "example.com"];

function check(schema: string, role: string) {
  if (!IDENT.test(schema) || schema === "public")
    throw new Error(`Not an isolated schema: "${schema}".`);
  if (!IDENT.test(role)) throw new Error(`Bad role name: "${role}".`);
}

function asLodge(schema: string, role: string) {
  return `BEGIN;
SET LOCAL ROLE ${role};
SET LOCAL search_path TO ${schema};
DO $guard$ BEGIN
  IF current_user <> '${role}' OR current_schema() IS DISTINCT FROM '${schema}' THEN
    RAISE EXCEPTION 'not running as ${role} in schema ${schema}';
  END IF;
END $guard$;`;
}

const demoEmailSql = DEMO_DOMAINS.map(
  (d) => `lower(guest_email) LIKE '%@${d}'`,
).join(" OR ");

/** `pnpm demo seed`, as one transaction. */
export function seedTransaction(
  schema: string,
  role: string,
  slug = "lodge-on-the-lake",
): string {
  check(schema, role);
  if (!SLUG.test(slug)) throw new Error(`Bad property slug: "${slug}".`);
  return `${asLodge(schema, role)}
DO $seed$
DECLARE
  pid uuid;
  real_bookings int;
  seeded boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'demo.seeded') INTO seeded;
  SELECT count(*)::int INTO real_bookings FROM reservations WHERE NOT (${demoEmailSql});
  IF real_bookings > 0 AND NOT seeded THEN
    RAISE EXCEPTION 'Refusing: this database holds % booking(s) that aren''t demo bookings. Seed only an empty staging database.', real_bookings;
  END IF;

  SELECT id INTO pid FROM properties WHERE slug = '${slug}';
  IF pid IS NULL THEN
    INSERT INTO properties (slug, name, time_zone, max_guests, default_min_nights,
      turnover_nights, check_in_time, check_out_time, bookings_enabled)
    VALUES ('${slug}', 'Lodge on the Lake', 'Europe/London', 6, 2, 0,
      '16:00 (placeholder)', '10:00 (placeholder)', true)
    RETURNING id INTO pid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM rate_rules WHERE property_id = pid) THEN
    INSERT INTO rate_rules (property_id, name, starts_on, ends_on, nightly_minor, weekend_nightly_minor)
    VALUES (pid, 'PLACEHOLDER rate — not real pricing', '2026-01-01', '2028-12-31', 15000, 18000);
    INSERT INTO fee_rules (property_id, name, kind, amount_minor, tax_treatment)
    VALUES (pid, 'Cleaning (placeholder)', 'PER_STAY', 6000, 'UNCONFIRMED');
    INSERT INTO payment_policies (property_id, mode) VALUES (pid, 'FULL');
  END IF;

  IF NOT seeded THEN
    INSERT INTO audit_logs (actor_type, action, target_type, target_id, metadata)
    VALUES ('SYSTEM', 'demo.seeded', 'property', pid::text,
      '{"note": "Demo/staging database: placeholder data only."}'::jsonb);
  END IF;
END $seed$;
COMMIT;`;
}

export interface Invitation {
  sql: string;
  /** The one-time set-up token: goes in the link, never in the SQL. */
  token: string;
  expiresAt: Date;
}

/** `pnpm admin invite`, as one transaction. */
export function inviteTransaction(
  schema: string,
  role: string,
  input: {
    email: string;
    role?: "OWNER" | "VIEWER";
    actor: string;
    now?: Date;
  },
): Invitation {
  check(schema, role);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Invalid email");
  const adminRole = input.role ?? "OWNER";
  if (adminRole !== "OWNER" && adminRole !== "VIEWER")
    throw new Error("Role must be OWNER or VIEWER");
  if (!/^[\w:.@-]{1,80}$/.test(input.actor)) throw new Error("Bad actor");
  const now = input.now ?? new Date();
  const token = randomToken();
  const expiresAt = new Date(
    now.getTime() + HOSTED_ENROLMENT_HOURS * 3_600_000,
  );
  const roleUpdate = input.role ? `, role = EXCLUDED.role` : "";
  const sql = `${asLodge(schema, role)}
WITH u AS (
  INSERT INTO admin_users (email, role, password_hash, totp_secret_encrypted,
    totp_last_step, recovery_code_hashes, enrolled_at, enrolment_token_hash,
    enrolment_expires_at, failed_attempts, locked_until)
  VALUES ('${email}', '${adminRole}', NULL, NULL, NULL, NULL, NULL,
    '${sha256(token)}', '${expiresAt.toISOString()}', 0, NULL)
  ON CONFLICT (email) DO UPDATE SET password_hash = NULL,
    totp_secret_encrypted = NULL, totp_last_step = NULL,
    recovery_code_hashes = NULL, enrolled_at = NULL,
    enrolment_token_hash = EXCLUDED.enrolment_token_hash,
    enrolment_expires_at = EXCLUDED.enrolment_expires_at,
    failed_attempts = 0, locked_until = NULL${roleUpdate}
  RETURNING id, role
), revoked AS (
  UPDATE admin_sessions SET revoked_at = '${now.toISOString()}'
  WHERE user_id = (SELECT id FROM u) AND revoked_at IS NULL
)
INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
SELECT 'OWNER', '${input.actor}', 'admin.enrolment_issued', 'admin_user', id::text,
  jsonb_build_object('role', role)
FROM u;
COMMIT;`;
  return { sql, token, expiresAt };
}

/** Read-only summary: counts only, no guest or owner details. */
export function statusQuery(schema: string): string {
  check(schema, "x");
  return `SELECT
  (SELECT count(*)::int FROM "${schema}".properties) AS properties,
  (SELECT string_agg(slug || ':' || booking_mode || ':' || bookings_enabled, ',') FROM "${schema}".properties) AS property_modes,
  (SELECT count(*)::int FROM "${schema}".rate_rules) AS rate_rules,
  (SELECT count(*)::int FROM "${schema}".admin_users) AS admin_users,
  (SELECT count(*)::int FROM "${schema}".admin_users WHERE enrolled_at IS NOT NULL) AS admins_enrolled,
  (SELECT count(*)::int FROM "${schema}".reservations) AS reservations,
  (SELECT EXISTS (SELECT 1 FROM "${schema}".audit_logs WHERE action = 'demo.seeded')) AS demo_seeded`;
}
