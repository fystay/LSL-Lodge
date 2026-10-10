import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPending,
  journalTableTransaction,
  loadMigrations,
  migrationTransaction,
  plan,
  preconditions,
  publicFingerprint,
  type Executor,
} from "./hosted-migrations";

/**
 * The hosted path (scripts/hosted-migrate.mts → Supabase Management API)
 * against a local copy of the staging database in its real partial state:
 * a stand-in other application in `public`, the Lodge role and schema, and
 * migrations 0000–0001 applied. The executor is a plain admin connection,
 * like the Management API's.
 */

const DB = "lodge_hosted_test";
const url = (db: string, user?: string, password?: string) => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password!;
  }
  return u.toString();
};
const PASSWORD = randomBytes(12).toString("hex");
let admin: postgres.Sql;
const exec: Executor = async (query) => {
  const result = await admin.unsafe(query);
  return result as unknown as Record<string, unknown>[];
};
const migrations = loadMigrations("lodge");

async function otherAppData() {
  const [row] = await admin`
    SELECT md5(string_agg(b::text, '|' ORDER BY b.id)) AS bookings,
           (SELECT md5(string_agg(u::text, '|' ORDER BY u.id)) FROM public."User" u) AS users
    FROM public."Booking" b`;
  return row;
}

beforeAll(async () => {
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${DB}`);
  await root.end();
  admin = postgres(url(DB), { max: 1, onnotice: () => {} });
  await admin.unsafe(`
    CREATE TABLE public."User" (id text PRIMARY KEY, email text);
    CREATE TABLE public."Booking" (id text PRIMARY KEY, "userId" text REFERENCES public."User"(id));
    CREATE TABLE public.reservations (id int PRIMARY KEY);
    INSERT INTO public."User" VALUES ('u1', 'person@other.app');
    INSERT INTO public."Booking" VALUES ('b1', 'u1');
    ALTER TABLE public."Booking" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own ON public."Booking" FOR SELECT TO authenticated USING (true);
    GRANT SELECT ON public."Booking" TO anon;
  `);
  await admin.unsafe(readFileSync("scripts/staging-database.sql", "utf8"));
  await admin.unsafe(`ALTER ROLE lodge_app WITH PASSWORD '${PASSWORD}'`);
  // The hosted database's state: 0000 and 0001 applied.
  await exec(journalTableTransaction("lodge", "lodge_app"));
  for (const m of migrations.slice(0, 2))
    await exec(migrationTransaction(m, "lodge", "lodge_app"));
}, 120_000);

afterAll(async () => {
  await admin?.end();
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.end();
});

describe("hosted migrations through an SQL executor", () => {
  it("checks the role and schema before doing anything", async () => {
    expect(await preconditions(exec, "lodge", "lodge_app")).toEqual([]);
    expect(await preconditions(exec, "lodge", "no_such_role")).toEqual([
      "role no_such_role doesn't exist (run scripts/staging-database.sql)",
    ]);
  });

  it("plans exactly the migrations the journal is missing", async () => {
    const p = await plan(exec, "lodge", migrations);
    expect(p.applied).toEqual(migrations.slice(0, 2).map((m) => m.tag));
    expect(p.pending.map((m) => m.tag)).toEqual(
      migrations.slice(2).map((m) => m.tag),
    );
    expect(p.unknown).toEqual([]);
  });

  it("leaves nothing behind when a migration fails part-way, and doesn't retry", async () => {
    const before = await publicFingerprint(exec);
    const pending = (await plan(exec, "lodge", migrations)).pending;
    const broken = [{ ...pending[0], sql: `${pending[0].sql}\nSELECT 1/0;` }];
    const calls: string[] = [];
    const counting: Executor = (q) => {
      calls.push(q);
      return exec(q);
    };
    const result = await applyPending(counting, "lodge", "lodge_app", broken);
    expect(result).toMatchObject({
      ok: false,
      failedAt: "0002_host_approval_workflow",
    });
    // One attempt only (plus the journal-table check and the rollback).
    expect(
      calls.filter((q) => q.includes("0002") || q.includes("booking_mode")),
    ).toHaveLength(1);
    // Atomic: 0002's new type doesn't exist, the journal is unchanged.
    const [{ present }] = await admin`
      SELECT to_regtype('lodge.booking_mode') IS NOT NULL AS present`;
    expect(present).toBe(false);
    expect((await plan(exec, "lodge", migrations)).applied).toHaveLength(2);
    expect(await publicFingerprint(exec)).toBe(before);
  });

  it("applies the rest in order, as lodge_app, without touching public", async () => {
    const fingerprint = await publicFingerprint(exec);
    const data = await otherAppData();
    const { pending } = await plan(exec, "lodge", migrations);
    const result = await applyPending(exec, "lodge", "lodge_app", pending);
    expect(result).toEqual({
      ok: true,
      applied: migrations.slice(2).map((m) => m.tag),
    });
    const after = await plan(exec, "lodge", migrations);
    expect(after.pending).toEqual([]);
    expect(after.applied).toHaveLength(migrations.length);
    expect(await publicFingerprint(exec)).toBe(fingerprint);
    expect(await otherAppData()).toEqual(data);

    const [owners] = await admin`
      SELECT count(*)::int AS not_owned FROM pg_tables
      WHERE schemaname = 'lodge' AND tableowner <> 'lodge_app'`;
    expect(owners.not_owned).toBe(0);

    // The normal migrator, as lodge_app, agrees nothing is left, and the
    // database passes the full verification.
    const env = {
      PATH: process.env.PATH ?? "",
      DATABASE_SCHEMA: "lodge",
      DATABASE_URL: url(DB, "lodge_app", PASSWORD),
      DATABASE_URL_UNPOOLED: url(DB, "lodge_app", PASSWORD),
    } as unknown as NodeJS.ProcessEnv;
    const migrate = spawnSync(
      "node_modules/.bin/tsx",
      ["scripts/migrate.mts"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(migrate.stdout).toMatch(/Migrations applied in schema "lodge"/);
    const verify = spawnSync(
      "node_modules/.bin/tsx",
      ["scripts/db-verify.mts"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(verify.stdout).toMatch(/All checks passed/);
  });

  it("refuses to apply a migration twice", async () => {
    const before = await publicFingerprint(exec);
    await expect(
      exec(migrationTransaction(migrations[5], "lodge", "lodge_app")),
    ).rejects.toThrow(/already applied/);
    await exec("ROLLBACK");
    expect((await plan(exec, "lodge", migrations)).applied).toHaveLength(
      migrations.length,
    );
    expect(await publicFingerprint(exec)).toBe(before);
  });
});
