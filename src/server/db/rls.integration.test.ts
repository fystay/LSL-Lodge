import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { pgErrorCode, testDatabase } from "../../../tests/support/test-db";

const db = testDatabase(2);
afterAll(async () => db.$client.end());

/**
 * Supabase exposes the public schema to its Data API roles (anon,
 * authenticated). The app never uses that API, so those roles must get
 * nothing. The test setup creates stand-in roles with Supabase's default
 * grants before migrating.
 */
describe("row level security", () => {
  it("is enabled on every public table", async () => {
    const rows = await db.execute<{ tablename: string; rowsecurity: boolean }>(
      sql`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)).toEqual(
      [],
    );
  });

  it("denies the Data API roles any access to booking or admin data", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of [
        "reservations",
        "admin_users",
        "payments",
        "external_calendar_sources",
      ]) {
        const error = await db
          .transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
            await tx.execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`));
          })
          .catch((e: unknown) => e);
        expect(pgErrorCode(error), `${role} on ${table}`).toBe("42501");
      }
    }
  });
});
