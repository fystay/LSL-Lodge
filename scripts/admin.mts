/**
 * Admin account management, run by whoever operates the deployment:
 *
 *   pnpm admin invite  --email owner@example.com [--role OWNER|VIEWER]
 *   pnpm admin reset   --email owner@example.com   (lost phone/password)
 *   pnpm admin disable --email someone@example.com
 *   pnpm admin enable  --email someone@example.com
 *   pnpm admin list
 *
 * Needs DATABASE_URL (and SITE_URL for the link). "invite" and "reset" print
 * a one-time set-up link, valid 24 hours, for the person to choose their own
 * password and authenticator. Send it to them privately; nothing here ever
 * sets or prints a password. Every action is audit-logged.
 */
import { parseArgs } from "node:util";
import { asc } from "drizzle-orm";
import { createDatabase } from "../src/server/db/client";
import { adminUsers } from "../src/server/db/schema";
import { issueEnrolment, setAdminDisabled } from "../src/server/admin/accounts";

const [command] = process.argv.slice(2);
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: { email: { type: "string" }, role: { type: "string" } },
});
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}
const db = createDatabase(url, { max: 1 });
const actor = `cli:${process.env.USER ?? "operator"}`;
const site = (process.env.SITE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

try {
  if (command === "invite" || command === "reset") {
    if (!values.email) throw new Error("--email is required");
    const role = values.role?.toUpperCase();
    if (role && role !== "OWNER" && role !== "VIEWER")
      throw new Error("--role must be OWNER or VIEWER");
    const { token, expiresAt } = await issueEnrolment(db, {
      email: values.email,
      role: role as "OWNER" | "VIEWER" | undefined,
      actor,
    });
    console.log(
      `Set-up link for ${values.email} (valid until ${expiresAt.toISOString()}). ` +
        `Send it privately; it works once.\n\n${site}/admin/enrol?t=${token}\n`,
    );
    if (command === "reset")
      console.log(
        "Their old password, authenticator and sessions no longer work.",
      );
  } else if (command === "disable" || command === "enable") {
    if (!values.email) throw new Error("--email is required");
    const ok = await setAdminDisabled(
      db,
      values.email,
      command === "disable",
      actor,
    );
    console.log(
      ok ? `${command}d ${values.email}` : `No account for ${values.email}`,
    );
  } else if (command === "list") {
    const rows = await db
      .select({
        email: adminUsers.email,
        role: adminUsers.role,
        enrolledAt: adminUsers.enrolledAt,
        disabledAt: adminUsers.disabledAt,
        lastLoginAt: adminUsers.lastLoginAt,
      })
      .from(adminUsers)
      .orderBy(asc(adminUsers.email));
    console.table(rows);
  } else {
    console.error(
      "Commands: invite, reset, disable, enable, list (see the file header).",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
