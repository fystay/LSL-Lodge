import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { rateLimits } from "@/server/db/schema";
import { resetTables, testDatabase } from "../../../tests/support/test-db";
import { consumeRateLimit, pruneRateLimits } from "./rate-limit";

const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => {
  await resetTables(db);
  await db.delete(rateLimits);
});
afterEach(() => vi.unstubAllEnvs());

const limit = { name: "test", max: 3, windowSeconds: 60 };
const T0 = new Date("2026-10-08T12:00:00Z");

describe("consumeRateLimit", () => {
  it("allows up to the limit per window, then refuses", async () => {
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await consumeRateLimit(db, limit, "203.0.113.7", T0));
    expect(results).toEqual([true, true, true, false, false]);
    // Next window starts afresh.
    expect(
      await consumeRateLimit(
        db,
        limit,
        "203.0.113.7",
        new Date(T0.getTime() + 60_000),
      ),
    ).toBe(true);
  });

  it("counts subjects separately and stores them only hashed", async () => {
    for (let i = 0; i < 3; i++)
      await consumeRateLimit(db, limit, "Guest@Example.test", T0);
    expect(await consumeRateLimit(db, limit, "other@example.test", T0)).toBe(
      true,
    );
    // Case and whitespace don't create a new bucket.
    expect(await consumeRateLimit(db, limit, " guest@example.test ", T0)).toBe(
      false,
    );
    const rows = await db.select().from(rateLimits);
    expect(JSON.stringify(rows)).not.toContain("example.test");
  });

  it("is atomic under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(db, limit, "x", T0)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("can be scaled up for test runs but never switched off", async () => {
    vi.stubEnv("RATE_LIMIT_SCALE", "2");
    const results = [];
    for (let i = 0; i < 7; i++)
      results.push(await consumeRateLimit(db, limit, "y", T0));
    expect(results.filter(Boolean)).toHaveLength(6);
    vi.stubEnv("RATE_LIMIT_SCALE", "0");
    expect(await consumeRateLimit(db, limit, "z", T0)).toBe(true);
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, limit, "z", T0);
    expect(await consumeRateLimit(db, limit, "z", T0)).toBe(false);
  });

  it("prunes old windows", async () => {
    await consumeRateLimit(db, limit, "old", T0);
    await pruneRateLimits(db, new Date(T0.getTime() + 3 * 86_400_000));
    expect(await db.select().from(rateLimits)).toHaveLength(0);
  });
});
