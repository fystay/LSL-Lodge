import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/server/db/client";
import { ownerBlocks, reservations } from "@/server/db/schema";
import { holdValues } from "../../../tests/support/test-db";

/**
 * `pnpm demo seed|status|reset` (scripts/demo.mts) only ever touches demo
 * data, on a database meant for it. Runs the real script against a
 * throwaway database.
 */

const DB = "lodge_demo_tools_test";
const url = (db: string) => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
};

function demo(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node_modules/.bin/tsx", ["scripts/demo.mts", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url(DB),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

let admin: postgres.Sql;
let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${DB}`);
  await root.end();
  const migrated = spawnSync("node_modules/.bin/tsx", ["scripts/migrate.mts"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL_UNPOOLED: url(DB),
    } as unknown as NodeJS.ProcessEnv,
  });
  expect(migrated.stdout).toMatch(/Migrations applied/);
  admin = postgres(url(DB), { max: 1, onnotice: () => {} });
  db = createDatabase(url(DB), { max: 1 });
}, 120_000);

afterAll(async () => {
  await db?.$client.end();
  await admin?.end();
  const root = postgres(url("postgres"), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.end();
});

describe("demo seed and reset", () => {
  it("refuses an unconfirmed remote host and live Stripe keys before connecting", () => {
    const remote = demo(["status"], {
      DATABASE_URL: "postgres://u:p@db.example.invalid:5432/postgres",
    });
    expect(remote.status).toBe(1);
    expect(remote.stderr).toMatch(/Refusing to touch "db.example.invalid"/);
    const live = demo(["status"], { STRIPE_SECRET_KEY: "sk_live_not_real" });
    expect(live.status).toBe(1);
    expect(live.stderr).toMatch(/not a test key/);
  });

  it("refuses to reset a database `seed` never marked", () => {
    const reset = demo(["reset", "--yes"]);
    expect(reset.status).toBe(1);
    expect(reset.stderr).toMatch(/not created with `pnpm demo seed`/);
  });

  it("refuses to seed (and so ever reset) a database holding real bookings", async () => {
    const [property] = await admin`
      INSERT INTO properties (slug, name, max_guests) VALUES ('other-lodge', 'Real', 4)
      RETURNING id`;
    const [real] = await db
      .insert(reservations)
      .values(
        holdValues(property.id, "2027-09-06", "2027-09-09", {
          guestEmail: "someone@gmail.com",
        }),
      )
      .returning();
    const seed = demo(["seed"]);
    expect(seed.status).toBe(1);
    expect(seed.stderr).toMatch(
      /holds 1 booking\(s\) that aren't demo bookings/,
    );
    expect(demo(["reset", "--yes"]).status).toBe(1);
    // Clean up for the next test (the test's own row only).
    await admin`DELETE FROM reservations WHERE id = ${real.id}`;
    await admin`DELETE FROM properties WHERE id = ${property.id}`;
  });

  it("is repeatable and deletes only demo bookings, [DEMO] blocks and test owners", async () => {
    expect(demo(["seed"]).stdout).toMatch(/Demo data ready/);
    expect(demo(["seed"]).stdout).toMatch(/Demo data ready/); // idempotent
    const [property] = await admin`
      SELECT id FROM properties WHERE slug = 'lodge-on-the-lake'`;

    for (let round = 1; round <= 2; round++) {
      // A real booking added after seeding (e.g. a manual test with a real
      // address) and a real block must survive every reset.
      const [real] = await db
        .insert(reservations)
        .values(
          holdValues(property.id, `2027-1${round}-01`, `2027-1${round}-04`, {
            guestEmail: `Real.Guest${round}@Gmail.com`,
          }),
        )
        .returning();
      await db.insert(reservations).values([
        holdValues(property.id, `2027-1${round}-08`, `2027-1${round}-11`, {
          guestEmail: "Demo.Guest@Example.Test",
        }),
        holdValues(property.id, `2027-1${round}-15`, `2027-1${round}-18`, {
          guestEmail: "guest@example.com",
        }),
      ]);
      await db.insert(ownerBlocks).values([
        {
          propertyId: property.id,
          startsOn: `2028-0${round}-01`,
          endsOn: `2028-0${round}-03`,
          reason: "[DEMO] owner stay",
          createdBy: "owner@example.test",
        },
        {
          propertyId: property.id,
          startsOn: `2028-0${round}-10`,
          endsOn: `2028-0${round}-12`,
          reason: "Family visit",
          createdBy: "owner@example.test",
        },
      ]);
      await admin`
        INSERT INTO admin_users (email, role, password_hash, totp_secret_encrypted, enrolled_at)
        VALUES (${`owner-${round}@example.test`}, 'OWNER', 'unusable', 'unusable', now()),
               (${`real-owner-${round}@example.test`}, 'OWNER', '$argon2id$real', 'x', now())`;

      const dry = demo(["reset"]);
      expect(dry.status).toBe(1);
      expect(dry.stderr).toMatch(/Nothing deleted/);
      expect(
        (await admin`SELECT count(*)::int AS n FROM reservations`)[0].n,
      ).toBe(round === 1 ? 3 : 4);

      expect(demo(["reset", "--yes"]).stdout).toMatch(/Demo data reset/);
      const left =
        await admin`SELECT guest_email FROM reservations ORDER BY guest_email`;
      expect(left.map((r) => r.guest_email)).toEqual(
        Array.from({ length: round }, (_, i) => `Real.Guest${i + 1}@Gmail.com`),
      );
      const blocks = await admin`SELECT reason FROM owner_blocks`;
      expect(blocks.every((b) => b.reason === "Family visit")).toBe(true);
      expect(blocks).toHaveLength(round);
      const owners = await admin`SELECT email FROM admin_users ORDER BY email`;
      expect(owners.map((o) => o.email)).toEqual(
        Array.from(
          { length: round },
          (_, i) => `real-owner-${i + 1}@example.test`,
        ),
      );
      expect(real.id).toBeTruthy();
    }
  });

  it("refuses a database that also holds another application's tables", async () => {
    await admin`CREATE TABLE public."User" (id text PRIMARY KEY)`;
    try {
      const status = demo(["status"]);
      expect(status.status).toBe(1);
      expect(status.stderr).toMatch(/another application's tables/);
    } finally {
      await admin`DROP TABLE public."User"`;
    }
  });
});
