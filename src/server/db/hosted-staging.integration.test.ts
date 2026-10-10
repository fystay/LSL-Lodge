import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@/server/admin/credentials";
import {
  applyPending,
  loadMigrations,
  plan,
  publicFingerprint,
  type Executor,
} from "./hosted-migrations";
import {
  inviteTransaction,
  seedTransaction,
  statusQuery,
} from "./hosted-staging";

/**
 * scripts/hosted-staging.mts against a local copy of the staging database:
 * a stand-in other application in `public`, the Lodge role and schema, all
 * migrations applied. The executor is a plain admin connection, like the
 * Management API's.
 */

const DB = "lodge_hosted_staging_test";
const url = (db: string) => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
};
let admin: postgres.Sql;
const exec: Executor = async (query) =>
  (await admin.unsafe(query)) as unknown as Record<string, unknown>[];
const status = async () => (await exec(statusQuery("lodge")))[0];

beforeAll(async () => {
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${DB}`);
  await root.end();
  admin = postgres(url(DB), { max: 1, onnotice: () => {} });
  await admin.unsafe(`
    CREATE TABLE public."User" (id text PRIMARY KEY, email text);
    CREATE TABLE public.audit_logs (id int PRIMARY KEY, action text);
    INSERT INTO public."User" VALUES ('u1', 'person@other.app');
    INSERT INTO public.audit_logs VALUES (1, 'demo.seeded');
  `);
  await admin.unsafe(readFileSync("scripts/staging-database.sql", "utf8"));
  await admin.unsafe(
    `ALTER ROLE lodge_app WITH PASSWORD '${randomBytes(12).toString("hex")}'`,
  );
  const migrations = loadMigrations("lodge");
  const { pending } = await plan(exec, "lodge", migrations);
  const result = await applyPending(exec, "lodge", "lodge_app", pending);
  expect(result.ok).toBe(true);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.end();
});

describe("hosted staging seed", () => {
  it("creates the placeholder property, prices and payment plan once", async () => {
    const fingerprint = await publicFingerprint(exec);
    // A same-named table in `public` doesn't count as "already seeded".
    await exec(seedTransaction("lodge", "lodge_app"));
    await exec(seedTransaction("lodge", "lodge_app"));
    expect(await status()).toMatchObject({
      properties: 1,
      property_modes: "lodge-on-the-lake:REQUEST:true",
      rate_rules: 1,
      demo_seeded: true,
    });
    const [counts] = await admin`
      SELECT (SELECT count(*)::int FROM lodge.fee_rules) AS fees,
             (SELECT count(*)::int FROM lodge.payment_policies) AS policies,
             (SELECT count(*)::int FROM lodge.audit_logs WHERE action = 'demo.seeded') AS marks,
             (SELECT rate.name FROM lodge.rate_rules rate) AS rate_name,
             (SELECT count(*)::int FROM public.audit_logs) AS other_app_rows`;
    expect(counts).toMatchObject({
      fees: 1,
      policies: 1,
      marks: 1,
      other_app_rows: 1,
    });
    expect(counts.rate_name).toMatch(/PLACEHOLDER/);
    expect(await publicFingerprint(exec)).toBe(fingerprint);
  });

  it("rows it creates belong to the Lodge role", async () => {
    const [row] = await admin`
      SELECT tableowner FROM pg_tables WHERE schemaname = 'lodge' AND tablename = 'properties'`;
    expect(row.tableowner).toBe("lodge_app");
  });

  it("refuses names that could escape the Lodge schema or role", () => {
    expect(() => seedTransaction("public", "lodge_app")).toThrow();
    expect(() => seedTransaction("lodge", "lodge_app; DROP")).toThrow();
    expect(() => seedTransaction("lodge", "lodge_app", "x'--")).toThrow();
  });
});

describe("hosted owner invitation", () => {
  it("stores only the token's hash and audits the invitation", async () => {
    const invite = inviteTransaction("lodge", "lodge_app", {
      email: "Demo-Owner@Example.test",
      actor: "cli:test",
    });
    expect(invite.sql).not.toContain(invite.token);
    await exec(invite.sql);
    const [user] = await admin`
      SELECT email, role, enrolment_token_hash, password_hash, enrolled_at
      FROM lodge.admin_users`;
    expect(user).toMatchObject({
      email: "demo-owner@example.test",
      role: "OWNER",
      enrolment_token_hash: sha256(invite.token),
      password_hash: null,
      enrolled_at: null,
    });
    const [audit] = await admin`
      SELECT actor_id, metadata FROM lodge.audit_logs
      WHERE action = 'admin.enrolment_issued'`;
    expect(audit).toMatchObject({
      actor_id: "cli:test",
      metadata: { role: "OWNER" },
    });
  });

  it("re-inviting replaces the token and revokes open sessions", async () => {
    const [{ id }] = await admin`SELECT id FROM lodge.admin_users`;
    await admin`
      INSERT INTO lodge.admin_sessions (user_id, token_hash, last_seen_at, expires_at)
      VALUES (${id}, 'session-hash', now(), now() + interval '1 day')`;
    const again = inviteTransaction("lodge", "lodge_app", {
      email: "demo-owner@example.test",
      actor: "cli:test",
    });
    await exec(again.sql);
    const [row] = await admin`
      SELECT u.enrolment_token_hash, s.revoked_at
      FROM lodge.admin_users u JOIN lodge.admin_sessions s ON s.user_id = u.id`;
    expect(row.enrolment_token_hash).toBe(sha256(again.token));
    expect(row.revoked_at).not.toBeNull();
    expect((await status()).admin_users).toBe(1);
  });

  it("rejects input that isn't a plain email, role or actor", () => {
    const base = { actor: "cli:test" };
    expect(() =>
      inviteTransaction("lodge", "lodge_app", { ...base, email: "x'@a.b" }),
    ).toThrow("Invalid email");
    expect(() =>
      inviteTransaction("lodge", "lodge_app", {
        ...base,
        email: "a@b.test",
        role: "ADMIN" as "OWNER",
      }),
    ).toThrow();
    expect(() =>
      inviteTransaction("lodge", "lodge_app", {
        email: "a@b.test",
        actor: "x'; DROP",
      }),
    ).toThrow("Bad actor");
  });
});
