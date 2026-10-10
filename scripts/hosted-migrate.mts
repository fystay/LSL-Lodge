/**
 * Applies the missing Lodge migrations to the shared staging database
 * through Supabase's Management API (for environments with no direct
 * Postgres connection). Dry run unless --apply.
 *
 *   SUPABASE_ACCESS_TOKEN=… (environment secret, never on the command line)
 *   pnpm db:hosted-migrate --project sqkpixwvugrxllrxlexs --name lsllodge [--apply]
 *
 * Safety (see src/server/db/hosted-migrations.ts):
 * - The project must have exactly the expected name (guards against a
 *   mistyped ref: the token can reach every project on the account).
 * - Each migration is one transaction, run as lodge_app inside schema
 *   lodge, verified before any statement; `public` references rewritten.
 * - A catalog-only fingerprint of `public` must be identical before and
 *   after; no data in `public` is read.
 * - Stops at the first error or timeout without retrying; run it again
 *   (dry run) to see from the journal what actually happened.
 * - Never prints the token. Database errors are printed (they hold no
 *   secrets: no credentials pass through SQL here).
 */
import {
  applyPending,
  loadMigrations,
  plan,
  preconditions,
  publicFingerprint,
  type Executor,
} from "../src/server/db/hosted-migrations";
import { targetSchema } from "../src/server/db/isolation";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const token = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!token) fail("Set SUPABASE_ACCESS_TOKEN as an environment secret.");
const ref = option("--project") ?? "";
const expectedName = option("--name") ?? "";
if (!/^[a-z]{20}$/.test(ref)) fail("Pass --project <20-letter project ref>.");
if (!expectedName) fail("Pass --name <project name> to confirm the target.");
const schema = process.env.DATABASE_SCHEMA ? targetSchema() : "lodge";
if (schema === "public") fail("Refusing: the Lodge schema can't be public.");
const role = option("--role") ?? "lodge_app";
const apply = args.includes("--apply");

const api = `https://api.supabase.com/v1/projects/${ref}`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

const project = await fetch(api, {
  headers,
  signal: AbortSignal.timeout(20_000),
});
if (!project.ok) fail(`Can't read project ${ref}: HTTP ${project.status}.`);
const info = (await project.json()) as { name?: string; status?: string };
if (info.name !== expectedName)
  fail(
    `Refusing: project ${ref} is named "${info.name}", not "${expectedName}".`,
  );
if (info.status !== "ACTIVE_HEALTHY")
  fail(`Refusing: project status is ${info.status}.`);
console.log(
  `Project ${ref} ("${info.name}"), schema "${schema}", role ${role}.`,
);

class Uncertain extends Error {}
const exec: Executor = async (query) => {
  let res: Response;
  try {
    res = await fetch(`${api}/database/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Uncertain(
      `no response (${(error as Error).name}): outcome unknown`,
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body) as Record<string, unknown>[];
};

const problems = await preconditions(exec, schema, role);
if (problems.length > 0) fail(`Refusing: ${problems.join("; ")}.`);

const migrations = loadMigrations(schema);
const before = await plan(exec, schema, migrations);
if (before.unknown.length > 0)
  fail(
    `Refusing: the journal has entries this branch doesn't know (${before.unknown.join(", ")}).`,
  );
console.log(`Applied: ${before.applied.join(", ") || "(none)"}`);
console.log(
  `Pending: ${before.pending.map((m) => m.tag).join(", ") || "(none)"}`,
);
if (before.pending.length === 0) process.exit(0);
if (!apply) {
  console.log("Dry run. Re-run with --apply to apply the pending migrations.");
  process.exit(0);
}

const fingerprint = await publicFingerprint(exec);
const result = await applyPending(exec, schema, role, before.pending, (m) =>
  console.log(m),
);
const after = await plan(exec, schema, migrations);
const unchanged = (await publicFingerprint(exec)) === fingerprint;
console.log(
  `Journal now: ${after.applied.length} of ${migrations.length} applied.`,
);
console.log(
  unchanged
    ? "public: unchanged (catalog fingerprint identical)."
    : "WARNING: public's catalog fingerprint changed during the run. Stop and investigate.",
);
if (!result.ok) {
  console.error(
    `Stopped at ${result.failedAt}: ${result.reason}. Not retried. Run again without --apply to see the state.`,
  );
  process.exit(1);
}
process.exit(unchanged && after.pending.length === 0 ? 0 : 1);
