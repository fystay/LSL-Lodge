import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations, webhookEvents } from "@/server/db/schema";
import {
  createProperty,
  holdValues,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { applyRetention } from "./retention";

const db = testDatabase(5);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

const NOW = new Date("2033-06-01T12:00:00Z");
const SIX_YEARS = 6 * 365;

async function booking(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  status: "CANCELLED" | "REQUIRES_REVIEW" | null,
) {
  const [r] = await db
    .insert(reservations)
    .values(
      holdValues(propertyId, checkIn, checkOut, {
        guestName: "Real Person",
        guestEmail: "person@example.test",
        guestPhone: "07700 900000",
        ownerNote: "Arrives late",
      }),
    )
    .returning();
  if (status)
    await db
      .update(reservations)
      .set({ status, holdExpiresAt: null })
      .where(eq(reservations.id, r.id));
  return r.id;
}

const load = async (id: string) =>
  (await db.select().from(reservations).where(eq(reservations.id, id)))[0];

describe("data retention", () => {
  it("removes guest details only from finished bookings past the retention period", async () => {
    const property = await createProperty(db);
    const old = await booking(
      property.id,
      "2027-03-01",
      "2027-03-04",
      "CANCELLED",
    );
    const recent = await booking(
      property.id,
      "2029-03-01",
      "2029-03-04",
      "CANCELLED",
    );
    // Still waiting on the owner: kept until resolved.
    const unresolved = await booking(
      property.id,
      "2027-04-05",
      "2027-04-08",
      "REQUIRES_REVIEW",
    );

    const result = await applyRetention(db, NOW, SIX_YEARS);
    expect(result.guestDetailsRemoved).toBe(1);

    const o = await load(old);
    expect(o).toMatchObject({
      guestName: "Removed (retention)",
      guestEmail: `guest-${old}@removed.invalid`,
      guestPhone: null,
      ownerNote: null,
      // The booking record itself is kept.
      status: "CANCELLED",
      totalMinor: 50_000,
    });
    expect((await load(recent)).guestEmail).toBe("person@example.test");
    expect((await load(unresolved)).guestEmail).toBe("person@example.test");

    // Idempotent.
    expect((await applyRetention(db, NOW, SIX_YEARS)).guestDetailsRemoved).toBe(
      0,
    );
  });

  it("drops processed webhook records after 90 days, keeping failed ones", async () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    await db.insert(webhookEvents).values([
      {
        provider: "stripe",
        providerEventId: "evt_old",
        type: "x",
        state: "PROCESSED",
        receivedAt: at(100),
      },
      {
        provider: "stripe",
        providerEventId: "evt_new",
        type: "x",
        state: "PROCESSED",
        receivedAt: at(10),
      },
      {
        provider: "stripe",
        providerEventId: "evt_failed",
        type: "x",
        state: "FAILED",
        receivedAt: at(100),
      },
    ]);
    expect((await applyRetention(db, NOW, SIX_YEARS)).webhookEvents).toBe(1);
    const left = (await db.select().from(webhookEvents)).map(
      (e) => e.providerEventId,
    );
    expect(left.sort()).toEqual(["evt_failed", "evt_new"]);
  });
});
