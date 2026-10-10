/**
 * Demo data and the owner's set-up link on the shared staging database,
 * through Supabase's Management API (for environments with no direct
 * Postgres connection; elsewhere use `pnpm demo seed` / `pnpm admin invite`).
 *
 *   SUPABASE_ACCESS_TOKEN=… (environment secret, never on the command line)
 *   pnpm staging:hosted status --project <ref> --name lsllodge
 *   pnpm staging:hosted seed   --project <ref> --name lsllodge
 *   pnpm staging:hosted invite --project <ref> --name lsllodge \
 *        --email owner@example.com --out <file> [--role OWNER|VIEWER]
 *
 * Same values and refusals as the direct-connection commands (see
 * src/server/db/hosted-staging.ts). Runs only as lodge_app in schema lodge,
 * after the same isolation preconditions as the hosted migrations.
 *
 * `invite` writes the one-time set-up link to --out (created with mode 0600,
 * never overwritten) instead of printing it, so it doesn't land in logs.
 * SITE_URL gives the link's origin.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { preconditions } from "../src/server/db/hosted-migrations";
import {
  inviteTransaction,
  seedTransaction,
  statusQuery,
} from "../src/server/db/hosted-staging";
import { targetSchema } from "../src/server/db/isolation";
import { managementApiExecutor } from "../src/server/db/management-api";

const [command] = process.argv.slice(2);
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    project: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string" },
    out: { type: "string" },
  },
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!["status", "seed", "invite"].includes(command ?? ""))
  fail(
    "Usage: pnpm staging:hosted <status|seed|invite> --project <ref> --name <name> …",
  );
const schema = process.env.DATABASE_SCHEMA ? targetSchema() : "lodge";
if (schema === "public") fail("Refusing: the Lodge schema can't be public.");
const role = "lodge_app";

const exec = await managementApiExecutor({
  ref: values.project ?? "",
  expectedName: values.name ?? "",
}).catch((error: Error) => fail(error.message));

const problems = await preconditions(exec, schema, role);
if (problems.length > 0) fail(`Refusing: ${problems.join("; ")}.`);

if (command === "seed") {
  await exec(seedTransaction(schema, role, process.env.PROPERTY_SLUG));
  console.log(`Demo data ready in schema "${schema}".`);
} else if (command === "invite") {
  if (!values.email) fail("--email is required");
  if (!values.out) fail("--out <file> is required (the link is never printed)");
  const site = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(site))
    fail("Set SITE_URL to the staging https origin.");
  const adminRole = values.role?.toUpperCase();
  if (adminRole && adminRole !== "OWNER" && adminRole !== "VIEWER")
    fail("--role must be OWNER or VIEWER");
  const invitation = inviteTransaction(schema, role, {
    email: values.email!,
    role: adminRole as "OWNER" | "VIEWER" | undefined,
    actor: `cli:${process.env.USER ?? "operator"}`,
  });
  // Write the (still unusable) link first so a failed write can't leave a
  // live token nobody holds.
  writeFileSync(values.out!, `${site}/admin/enrol?t=${invitation.token}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await exec(invitation.sql);
  console.log(
    `Set-up link for ${values.email} written to ${values.out} (valid until ${invitation.expiresAt.toISOString()}, works once).`,
  );
}

const [status] = await exec(statusQuery(schema));
console.log(status);
