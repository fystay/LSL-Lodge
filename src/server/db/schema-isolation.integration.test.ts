import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  createHold,
  createOwnerBlock,
  expireLapsedHolds,
} from "@/server/booking/holds";
import { guestCancel } from "@/server/booking/resolution";
import {
  applyCheckoutSession,
  startCheckout,
} from "@/server/payments/checkout";
import { reconcilePayments } from "@/server/payments/reconcile";
import { sendRefund } from "@/server/payments/refunds";
import { checkDatabase } from "@/server/ops/preflight";
import { applyRetention } from "@/server/privacy/retention";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import { createBookableProperty } from "../../../tests/support/test-db";
import { createDatabase } from "./client";
import { isolationProblems, isolationState, toSchema } from "./isolation";
import * as schema from "./schema";

/**
 * The staging database shares a Supabase project with another application
 * whose tables live in `public`. These tests rebuild that situation in a
 * throwaway database: a stand-in "other app" in `public` (rows, RLS policy,
 * grants, a trigger, and tables and a type that deliberately reuse Lodge
 * names), then the Lodge set up exactly as on staging. They prove that the
 * Lodge's migrations, its runtime code and its demo tools leave every bit
 * of `public` untouched, and that the role can't reach it even when asked.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL!;
const DB = "lodge_isolation_test";
const adminUrl = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const PASSWORD = randomBytes(12).toString("hex");
const appUrl = () => {
  const u = new URL(adminUrl(DB));
  u.username = "lodge_app";
  u.password = PASSWORD;
  return u.toString();
};

let admin: postgres.Sql;

/** Everything about `public` the other application relies on. */
async function publicSnapshot() {
  const [row] = await admin`
    SELECT json_build_object(
      'relations', (SELECT json_agg(json_build_object(
          'name', c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity,
          'force', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner),
          'acl', c.relacl::text) ORDER BY c.relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'),
      'columns', (SELECT json_agg(table_name || '.' || column_name || ':' || data_type
          ORDER BY table_name, ordinal_position)
        FROM information_schema.columns WHERE table_schema = 'public'),
      'policies', (SELECT json_agg(row_to_json(p) ORDER BY p.tablename, p.policyname)
        FROM pg_policies p WHERE p.schemaname = 'public'),
      'grants', (SELECT json_agg(grantee || ':' || table_name || ':' || privilege_type
          ORDER BY grantee, table_name, privilege_type)
        FROM information_schema.role_table_grants WHERE table_schema = 'public'),
      'default_acl', (SELECT json_agg(pg_get_userbyid(a.defaclrole) || ':' || a.defaclacl::text ORDER BY 1)
        FROM pg_default_acl a JOIN pg_namespace n ON n.oid = a.defaclnamespace
        WHERE n.nspname = 'public'),
      'functions', (SELECT json_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || coalesce(array_to_string(p.proconfig, ','), '') ORDER BY 1)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      'types', (SELECT json_agg(t.typname || ':' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') ORDER BY t.typname)
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'),
      'triggers', (SELECT json_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text ORDER BY 1)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal),
      'schema_acl', (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public'),
      'data', json_build_object(
        'User', (SELECT md5(string_agg(u::text, '|' ORDER BY u.id)) FROM public."User" u),
        'Booking', (SELECT md5(string_agg(b::text, '|' ORDER BY b.id)) FROM public."Booking" b),
        'reservations', (SELECT md5(string_agg(r::text, '|' ORDER BY r.id)) FROM public.reservations r),
        'properties', (SELECT md5(string_agg(p::text, '|' ORDER BY p.id)) FROM public.properties p))
    ) AS snapshot`;
  return row.snapshot;
}

function run(script: string, args: string[], env: Record<string, string>) {
  return spawnSync("node_modules/.bin/tsx", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    timeout: 120_000,
  });
}
const migrate = (url: string) =>
  run("scripts/migrate.mts", [], {
    DATABASE_SCHEMA: "lodge",
    DATABASE_URL_UNPOOLED: url,
  });

let before: unknown;

beforeAll(async () => {
  const root = postgres(adminUrl("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${DB}`);
  await root.end();
  admin = postgres(adminUrl(DB), { max: 1, onnotice: () => {} });

  // The other application, Supabase-style.
  await admin.unsafe(`
    CREATE TABLE public."User" (id text PRIMARY KEY, email text NOT NULL);
    CREATE TABLE public."Booking" (id text PRIMARY KEY, "userId" text REFERENCES public."User"(id), status text);
    -- Same names as Lodge objects, on purpose.
    CREATE TABLE public.reservations (id int PRIMARY KEY, note text);
    CREATE TABLE public.properties (id int PRIMARY KEY, slug text);
    CREATE TYPE public.reservation_status AS ENUM ('THEIRS');
    INSERT INTO public."User" VALUES ('u1', 'person@other.app'), ('u2', 'second@other.app');
    INSERT INTO public."Booking" VALUES ('b1', 'u1', 'PAID'), ('b2', 'u2', 'PENDING');
    INSERT INTO public.reservations VALUES (1, 'not the lodge');
    INSERT INTO public.properties VALUES (1, 'lodge-on-the-lake');
    ALTER TABLE public."Booking" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "own bookings" ON public."Booking" FOR SELECT TO authenticated USING (true);
    GRANT SELECT, INSERT ON public."Booking" TO anon, authenticated;
    GRANT SELECT ON public.reservations TO anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;
    CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER booking_touch BEFORE UPDATE ON public."Booking" FOR EACH ROW EXECUTE FUNCTION public.touch();
  `);
  before = await publicSnapshot();

  // The Lodge, exactly as set up on staging.
  const { readFileSync } = await import("node:fs");
  await admin.unsafe(readFileSync("scripts/staging-database.sql", "utf8"));
  await admin.unsafe(`ALTER ROLE lodge_app WITH PASSWORD '${PASSWORD}'`);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  const root = postgres(adminUrl("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.end();
});

describe("Lodge schema isolation on a shared database", () => {
  it("refuses to migrate through a connection that can reach public", () => {
    // The administrator: a superuser that resolves names in public.
    const asAdmin = migrate(adminUrl(DB));
    expect(asAdmin.status).not.toBe(0);
    expect(asAdmin.stderr).toMatch(/Refusing to migrate schema "lodge"/);
    expect(asAdmin.stderr).toMatch(/superuser/);
  });

  it("recovers from the staging database's partial state (0000–0001 applied)", async () => {
    // Recreate what the hosted database holds: the first two migrations,
    // applied as lodge_app from the printed bundle.
    const printed = run("scripts/migrate.mts", ["--print"], {
      DATABASE_SCHEMA: "lodge",
    });
    expect(printed.status).toBe(0);
    const partial = printed.stdout.slice(
      0,
      printed.stdout.indexOf("-- 0002_host_approval_workflow"),
    );
    await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE lodge_app");
      await tx.unsafe(partial);
    });
    await admin.unsafe("RESET search_path");
    const app = postgres(appUrl(), { max: 1, onnotice: () => {} });
    try {
      const journal = await app`SELECT created_at FROM __drizzle_migrations`;
      expect(journal).toHaveLength(2);

      const first = migrate(appUrl());
      expect(first.stderr).toBe("");
      expect(first.stdout).toMatch(/Migrations applied in schema "lodge"/);
      // Idempotent: a second run changes nothing.
      expect(migrate(appUrl()).status).toBe(0);
      const all = await app`SELECT created_at FROM __drizzle_migrations`;
      expect(all).toHaveLength(11);

      const verify = run("scripts/db-verify.mts", [], {
        DATABASE_SCHEMA: "lodge",
        DATABASE_URL: appUrl(),
      });
      expect(verify.stdout).toMatch(/All checks passed/);
      expect(verify.stdout).toMatch(
        /PASS {2}connection isolated to schema "lodge"/,
      );
    } finally {
      await app.end();
    }
    expect(await publicSnapshot()).toEqual(before);
  });

  it("puts every Lodge object in lodge, owned by lodge_app, with functions pinned", async () => {
    const [counts] = await admin`
      SELECT
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'lodge') AS tables,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'lodge' AND tableowner <> 'lodge_app') AS foreign_owned,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'lodge' AND NOT rowsecurity) AS without_rls,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'lodge' AND NOT coalesce(p.proconfig @> ARRAY['search_path=lodge, pg_catalog'], false)) AS unpinned`;
    const ours = Object.values(schema).filter((v) => is(v, PgTable)).length;
    expect(counts).toEqual({
      tables: ours + 1, // + the migration journal
      foreign_owned: 0,
      without_rls: 0,
      unpinned: 0,
    });
  });

  it("reports the Lodge role as fully isolated", async () => {
    const app = postgres(appUrl(), { max: 1, onnotice: () => {} });
    try {
      const state = await isolationState(app);
      expect(isolationProblems(state, "lodge")).toEqual([]);
      expect(state.publicRelationsReachable).toBe(0);
    } finally {
      await app.end();
    }
  });

  it("can't read, change, re-permission or drop the other application's objects", async () => {
    const app = postgres(appUrl(), { max: 1, onnotice: () => {} });
    const attempts = [
      `SELECT * FROM public."Booking"`,
      `SELECT * FROM public."User"`,
      `INSERT INTO public.reservations VALUES (2, 'x')`,
      `UPDATE public."Booking" SET status = 'X'`,
      `DELETE FROM public."User"`,
      `TRUNCATE public."Booking"`,
      `ALTER TABLE public."Booking" DISABLE ROW LEVEL SECURITY`,
      `DROP POLICY "own bookings" ON public."Booking"`,
      `DROP TABLE public."Booking"`,
      `CREATE TABLE public.lodge_probe (id int)`,
      `ALTER TYPE public.reservation_status ADD VALUE 'LODGE'`,
      `DROP TRIGGER booking_touch ON public."Booking"`,
    ];
    try {
      for (const statement of attempts) {
        const error = await app
          .unsafe(statement)
          .then(() => null)
          .catch((e: { code?: string }) => e);
        expect(error, statement).not.toBeNull();
        expect(error!.code, statement).toMatch(/^42501$|^42809$/);
      }
      // GRANT/REVOKE without privileges are warnings, not errors: they must
      // change nothing either (checked by the snapshot below).
      await app
        .unsafe(`GRANT ALL ON public."Booking" TO lodge_app`)
        .catch(() => {});
      await app
        .unsafe(`REVOKE ALL ON public."Booking" FROM anon`)
        .catch(() => {});
    } finally {
      await app.end();
    }
    expect(await publicSnapshot()).toEqual(before);
  });

  it("runs the booking, payment, refund, block and job code without touching public", async () => {
    const db = createDatabase(appUrl(), { max: 2 });
    try {
      const property = await createBookableProperty(db);
      const hold = await createHold(db, {
        propertyId: property.id,
        checkIn: d("2027-06-07"),
        checkOut: d("2027-06-10"),
        guests: 2,
        guest: { name: "Isolation Guest", email: "isolation@example.test" },
        idempotencyKey: randomUUID(),
      });
      if (!hold.ok) throw new Error(`expected a hold: ${hold.reason}`);
      const gateway = new FakeGateway();
      await startCheckout(db, gateway, {
        reservationId: hold.reservationId,
        baseUrl: "http://localhost:3000",
      });
      expect(
        await applyCheckoutSession(db, gateway.pay(gateway.latest().id)),
      ).toBe("CONFIRMED");
      const cancelled = await guestCancel(db, {
        propertyId: property.id,
        reservationId: hold.reservationId,
        receivedAt: new Date(),
      });
      if (!cancelled.ok || cancelled.outcome !== "CANCELLED_WITH_REFUND")
        throw new Error("expected a policy refund");
      expect(await sendRefund(db, gateway, cancelled.refundIds[0])).toBe(
        "SUCCEEDED",
      );
      const block = await createOwnerBlock(db, {
        propertyId: property.id,
        startsOn: d("2027-07-05"),
        endsOn: d("2027-07-08"),
        reason: "[DEMO] isolation",
        createdBy: "owner@example.test",
      });
      expect(block).toMatchObject({ ok: true });
      await expireLapsedHolds(db, null, new Date());
      await reconcilePayments(db, gateway, new Date(Date.now() + 20 * 60_000));
      await applyRetention(db, new Date());

      const [lodge] = await admin`
        SELECT (SELECT count(*)::int FROM lodge.reservations) AS reservations,
               (SELECT status::text FROM lodge.reservations LIMIT 1) AS status`;
      expect(lodge).toEqual({ reservations: 1, status: "REFUNDED" });
    } finally {
      await db.$client.end();
    }
    expect(await publicSnapshot()).toEqual(before);
  });

  it("runs the demo seed, status and reset against lodge only", async () => {
    const env = {
      DATABASE_URL: appUrl(),
      DATABASE_SCHEMA: "lodge",
      PROPERTY_SLUG: "lodge-on-the-lake",
    };
    expect(run("scripts/demo.mts", ["seed"], env).status).toBe(0);
    const status = run("scripts/demo.mts", ["status"], env);
    expect(JSON.parse(status.stdout)).toMatchObject({ demoDatabase: true });
    const reset = run("scripts/demo.mts", ["reset", "--yes"], env);
    expect(reset.stdout).toMatch(/Demo data reset/);
    // The other app's "properties" row with the same slug is untouched.
    expect(await publicSnapshot()).toEqual(before);
  });

  it("refuses to rewrite a migration that would still touch public", () => {
    expect(() =>
      toSchema(
        `ALTER TABLE public."Booking" ENABLE ROW LEVEL SECURITY;`,
        "lodge",
      ),
    ).toThrow(/refers to the public schema/);
    expect(() =>
      toSchema(`GRANT USAGE ON SCHEMA public TO anon;`, "lodge"),
    ).toThrow(/refers to the public schema/);
    expect(() => toSchema(`SELECT 1`, "public")).toThrow(
      /Not an isolated schema/,
    );
  });

  it("staging preflight reads the shared database without writing or leaking", async () => {
    const journalEntries = 11;
    const app = postgres(appUrl(), { max: 1, onnotice: () => {} });
    try {
      const checks = await checkDatabase(
        app,
        { DATABASE_SCHEMA: "lodge" },
        journalEntries,
      );
      const status = (label: string) =>
        checks.find((c) => c.label.startsWith(label))?.status;
      expect(status('isolated to schema "lodge"')).toBe("PASS");
      expect(status("all migrations applied")).toBe("PASS");
      expect(status('property "lodge-on-the-lake" exists')).toBe("PASS");
      expect(status("marked as a demo database")).toBe("PASS");
      // Only the test-minted kind of owner exists here: not a real one.
      expect(status("an owner account is set up")).toBe("FAIL");
      expect(status("calendar feeds")).toBe("WARN");
    } finally {
      await app.end();
    }

    // The administrator's connection is refused as the Lodge's.
    const asAdmin = await checkDatabase(
      admin,
      { DATABASE_SCHEMA: "lodge" },
      journalEntries,
    );
    expect(
      asAdmin.find((c) => c.label === 'isolated to schema "lodge"')?.status,
    ).toBe("FAIL");
    // And without DATABASE_SCHEMA the other app's tables are spotted.
    const unscoped = await checkDatabase(admin, {}, journalEntries);
    expect(
      unscoped.find(
        (c) => c.label === "no other application's tables alongside",
      )?.status,
    ).toBe("FAIL");

    // The command line never prints the password or a secret.
    const cronSecret = randomBytes(24).toString("hex");
    const cli = run("scripts/staging-preflight.mts", [], {
      DATABASE_URL: appUrl(),
      DATABASE_SCHEMA: "lodge",
      CRON_SECRET: cronSecret,
      STRIPE_SECRET_KEY: `sk_live_${cronSecret}`,
    });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toMatch(
      /PASS {2}\[database\] isolated to schema "lodge"/,
    );
    expect(cli.stdout).toMatch(
      /FAIL {2}\[environment\] STRIPE_SECRET_KEY is a TEST key/,
    );
    for (const leak of [PASSWORD, cronSecret, appUrl()])
      expect(cli.stdout + cli.stderr).not.toContain(leak);
    expect(await publicSnapshot()).toEqual(before);
  });
});
