import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations } from "@/server/db/schema";
import {
  createProperty,
  holdValues,
  pgErrorCode,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import {
  ALLOWED_TRANSITIONS,
  BLOCKING_STATUSES,
  RESERVATION_STATUSES,
  type ReservationStatus,
} from "./reservation-state";

const EXCLUSION_VIOLATION = "23P01";
const CHECK_VIOLATION = "23514";

const db = testDatabase(20);

afterAll(async () => {
  await db.$client.end();
});

beforeEach(async () => {
  await resetTables(db);
});

describe("reservations exclusion constraint", () => {
  it("rejects an overlapping active stay", async () => {
    const property = await createProperty(db);
    await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-10", "2026-07-13"));

    const error = await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-12", "2026-07-14"))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(EXCLUSION_VIOLATION);
  });

  it("allows check-out and check-in on the same date", async () => {
    const property = await createProperty(db);
    await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-10", "2026-07-13"));
    await expect(
      db
        .insert(reservations)
        .values(holdValues(property.id, "2026-07-13", "2026-07-15")),
    ).resolves.toBeDefined();
  });

  it("does not let other properties' stays conflict", async () => {
    const a = await createProperty(db);
    const b = await createProperty(db);
    await db
      .insert(reservations)
      .values(holdValues(a.id, "2026-07-10", "2026-07-13"));
    await expect(
      db
        .insert(reservations)
        .values(holdValues(b.id, "2026-07-10", "2026-07-13")),
    ).resolves.toBeDefined();
  });

  it("frees the dates once a hold expires", async () => {
    const property = await createProperty(db);
    const [hold] = await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-10", "2026-07-13"))
      .returning();
    await db
      .update(reservations)
      .set({ status: "EXPIRED" })
      .where(eq(reservations.id, hold.id));

    await expect(
      db
        .insert(reservations)
        .values(holdValues(property.id, "2026-07-10", "2026-07-13")),
    ).resolves.toBeDefined();
  });

  it("blocks a late payment from reviving an expired hold whose dates were re-booked", async () => {
    const property = await createProperty(db);
    const [stale] = await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-10", "2026-07-13"))
      .returning();
    await db
      .update(reservations)
      .set({ status: "EXPIRED" })
      .where(eq(reservations.id, stale.id));
    await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-07-11", "2026-07-12"));

    const error = await db
      .update(reservations)
      .set({ status: "REQUIRES_REVIEW" })
      .where(eq(reservations.id, stale.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(EXCLUSION_VIOLATION);
  });

  it("allows exactly one of many concurrent attempts for the same dates", async () => {
    const property = await createProperty(db);
    const attempts = 15;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        // Varying but overlapping ranges, submitted simultaneously.
        db
          .insert(reservations)
          .values(
            holdValues(property.id, `2026-08-${10 + (i % 3)}`, "2026-08-14"),
          ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    for (const r of rejected)
      expect(pgErrorCode(r.reason)).toBe(EXCLUSION_VIOLATION);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(eq(reservations.propertyId, property.id));
    expect(count).toBe(1);
  });
});

describe("reservation status rules in the database", () => {
  it("refuses to create a website reservation directly as CONFIRMED", async () => {
    const property = await createProperty(db);
    const error = await db
      .insert(reservations)
      .values(
        holdValues(property.id, "2026-09-01", "2026-09-03", {
          status: "CONFIRMED",
        }),
      )
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("only lets website reservations start as a request or an instant hold", async () => {
    const property = await createProperty(db);
    let day = 1;
    for (const status of RESERVATION_STATUSES) {
      const start = `2031-01-${String(day).padStart(2, "0")}`;
      const end = `2031-01-${String(day + 1).padStart(2, "0")}`;
      day += 2;
      const outcome = await db
        .insert(reservations)
        .values(
          holdValues(property.id, start, end, {
            status,
            approvedAt: new Date(),
          }),
        )
        .then(() => "allowed")
        .catch((e: unknown) => {
          expect(pgErrorCode(e)).toBe(CHECK_VIOLATION);
          return "rejected";
        });
      expect({ status, outcome }).toEqual({
        status,
        outcome:
          status === "REQUESTED" || status === "PENDING_PAYMENT"
            ? "allowed"
            : "rejected",
      });
    }
  });

  it("requires an approval time on an approved request", async () => {
    const property = await createProperty(db);
    const [row] = await db
      .insert(reservations)
      .values(
        holdValues(property.id, "2026-09-01", "2026-09-03", {
          status: "REQUESTED",
        }),
      )
      .returning();
    const error = await db
      .update(reservations)
      .set({ status: "APPROVED" })
      .where(eq(reservations.id, row.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("blocks overlapping requests just like bookings", async () => {
    const property = await createProperty(db);
    await db.insert(reservations).values(
      holdValues(property.id, "2026-09-01", "2026-09-05", {
        status: "REQUESTED",
      }),
    );
    const error = await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-09-04", "2026-09-06"))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(EXCLUSION_VIOLATION);
  });

  it("requires an expiry on every hold", async () => {
    const property = await createProperty(db);
    const error = await db
      .insert(reservations)
      .values(
        holdValues(property.id, "2026-09-01", "2026-09-03", {
          holdExpiresAt: null,
        }),
      )
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("keeps the quote snapshot immutable", async () => {
    const property = await createProperty(db);
    const [row] = await db
      .insert(reservations)
      .values(holdValues(property.id, "2026-09-01", "2026-09-03"))
      .returning();
    const error = await db
      .update(reservations)
      .set({ totalMinor: 1 })
      .where(eq(reservations.id, row.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it("enforces exactly the transitions in ALLOWED_TRANSITIONS", async () => {
    const property = await createProperty(db);
    let offset = 0;
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        if (from === to) continue;
        // Each pair gets its own dates so the exclusion constraint never interferes.
        const start = new Date(Date.UTC(2030, 0, 1 + offset * 2))
          .toISOString()
          .slice(0, 10);
        const end = new Date(Date.UTC(2030, 0, 2 + offset * 2))
          .toISOString()
          .slice(0, 10);
        offset += 1;

        const [row] = await db
          .insert(reservations)
          // approvedAt satisfies the APPROVED check constraint, so only the
          // transition trigger decides.
          .values(
            holdValues(property.id, start, end, { approvedAt: new Date() }),
          )
          .returning();
        await forceStatus(row.id, from);

        const outcome = await db
          .update(reservations)
          .set({ status: to })
          .where(eq(reservations.id, row.id))
          .then(() => "allowed" as const)
          .catch((e: unknown) => {
            expect(pgErrorCode(e)).toBe(CHECK_VIOLATION);
            return "rejected" as const;
          });
        const expected = ALLOWED_TRANSITIONS[from].includes(to)
          ? "allowed"
          : "rejected";
        expect({ from, to, outcome }).toEqual({ from, to, outcome: expected });
      }
    }
  });

  it("uses the same blocking statuses as the application", async () => {
    const [{ definition }] = await db.execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'reservations_no_overlapping_active_stays'
    `);
    const inConstraint = [
      ...definition.matchAll(/'([A-Z_]+)'::reservation_status/g),
    ].map((m) => m[1]);
    expect(inConstraint.sort()).toEqual([...BLOCKING_STATUSES].sort());
  });
});

/** Moves a test row into `status` by temporarily bypassing the transition trigger. */
async function forceStatus(id: string, status: ReservationStatus) {
  if (status === "PENDING_PAYMENT") return;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`ALTER TABLE reservations DISABLE TRIGGER reservations_status_transition`,
    );
    await tx
      .update(reservations)
      .set({ status })
      .where(eq(reservations.id, id));
    await tx.execute(
      sql`ALTER TABLE reservations ENABLE TRIGGER reservations_status_transition`,
    );
  });
}
