import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  auditLogs,
  externalBusyPeriods,
  externalCalendarSources,
  notificationJobs,
  paymentScheduleItems,
  reservations,
} from "@/server/db/schema";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { createHold } from "./holds";
import { approveRequest, declineRequest } from "./requests";

const db = testDatabase(20);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Test data only.
const NOW = new Date("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
const OWNER = "owner@example.test";

async function request(
  propertyId: string,
  checkIn = "2027-03-01",
  checkOut = "2027-03-04",
) {
  const result = await createHold(db, {
    propertyId,
    checkIn: d(checkIn),
    checkOut: d(checkOut),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
    now: NOW,
  });
  if (!result.ok) throw new Error(`expected request, got ${result.reason}`);
  return result;
}

const load = async (id: string) =>
  (await db.select().from(reservations).where(eq(reservations.id, id)))[0];

const templates = async (id: string) =>
  (
    await db
      .select({ t: notificationJobs.template })
      .from(notificationJobs)
      .where(eq(notificationJobs.reservationId, id))
  )
    .map((r) => r.t)
    .sort();

describe("approveRequest", () => {
  it("approves, holds the dates until the payment deadline and asks the guest to pay", async () => {
    const property = await createBookableProperty(db, {
      paymentWindowHours: 48,
    });
    const req = await request(property.id);
    const at = new Date(NOW.getTime() + 2 * HOUR);

    const result = await approveRequest(db, {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      ownerNote: "Returning guests",
      now: at,
    });
    expect(result).toEqual({
      ok: true,
      paymentDueBy: new Date(at.getTime() + 48 * HOUR),
    });

    const row = await load(req.reservationId);
    expect(row.status).toBe("APPROVED");
    expect(row.approvedBy).toBe(OWNER);
    expect(row.ownerNote).toBe("Returning guests");
    expect(row.holdExpiresAt).toEqual(new Date(at.getTime() + 48 * HOUR));
    // The agreed price never changes on approval.
    expect(row.totalMinor).toBe(30_000);

    const schedule = await db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, req.reservationId));
    expect(schedule.map((s) => [s.purpose, s.amountMinor, s.dueOn])).toEqual([
      ["FULL", 30_000, "2026-10-10"],
    ]);
    expect(await templates(req.reservationId)).toContain("request_approved");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, req.reservationId));
    expect(audits.map((a) => [a.action, a.actorId])).toContainEqual([
      "reservation.approved",
      OWNER,
    ]);
  });

  it("refuses a request whose response window has passed, and expires it", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    const result = await approveRequest(db, {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: new Date(NOW.getTime() + 25 * HOUR),
    });
    expect(result).toEqual({ ok: false, reason: "EXPIRED" });
    expect((await load(req.reservationId)).status).toBe("EXPIRED");
  });

  it("refuses when an imported calendar now overlaps the request", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    const [source] = await db
      .insert(externalCalendarSources)
      .values({
        propertyId: property.id,
        provider: "AIRBNB_ICAL",
        direction: "IMPORT",
        label: "Airbnb",
      })
      .returning();
    await db.insert(externalBusyPeriods).values({
      sourceId: source.id,
      propertyId: property.id,
      externalUid: "airbnb-1",
      startsOn: "2027-03-03",
      endsOn: "2027-03-05",
      contentHash: "h",
    });

    const result = await approveRequest(db, {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: "CONFLICT",
      sources: ["AIRBNB_ICAL"],
    });
    expect((await load(req.reservationId)).status).toBe("REQUESTED");
  });

  it("cannot approve twice, approve a declined request, or touch another property", async () => {
    const property = await createBookableProperty(db);
    const other = await createBookableProperty(db);
    const req = await request(property.id);
    const decide = (propertyId: string) =>
      approveRequest(db, {
        propertyId,
        reservationId: req.reservationId,
        actor: OWNER,
        now: NOW,
      });
    expect(await decide(other.id)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect((await decide(property.id)).ok).toBe(true);
    expect(await decide(property.id)).toEqual({
      ok: false,
      reason: "NOT_PENDING",
    });

    const second = await request(property.id, "2027-05-01", "2027-05-04");
    await declineRequest(db, {
      propertyId: property.id,
      reservationId: second.reservationId,
      actor: OWNER,
      now: NOW,
    });
    expect(
      await approveRequest(db, {
        propertyId: property.id,
        reservationId: second.reservationId,
        actor: OWNER,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "NOT_PENDING" });
  });

  it("lets exactly one of a simultaneous approve and decline win", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    const args = {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: NOW,
    };
    const [a, b] = await Promise.all([
      approveRequest(db, args),
      declineRequest(db, args),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(["APPROVED", "DECLINED"]).toContain(
      (await load(req.reservationId)).status,
    );
  });
});

describe("declineRequest", () => {
  it("releases the dates at once and tells the guest", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    expect(
      await declineRequest(db, {
        propertyId: property.id,
        reservationId: req.reservationId,
        actor: OWNER,
        ownerNote: "Dates needed for maintenance",
        now: NOW,
      }),
    ).toEqual({ ok: true });

    const row = await load(req.reservationId);
    expect(row.status).toBe("DECLINED");
    expect(row.declinedBy).toBe(OWNER);
    const schedule = await db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, req.reservationId));
    expect(schedule.every((s) => s.status === "CANCELLED")).toBe(true);
    expect(await templates(req.reservationId)).toContain("request_declined");

    // Someone else can now request the same dates.
    expect((await request(property.id)).ok).toBe(true);
  });

  it("does not decline an approved request", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    const args = {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: NOW,
    };
    await approveRequest(db, args);
    expect(await declineRequest(db, args)).toEqual({
      ok: false,
      reason: "NOT_PENDING",
    });
  });
});

describe("approved requests awaiting payment", () => {
  it("keep blocking the dates until the payment deadline, then expire", async () => {
    const property = await createBookableProperty(db);
    const req = await request(property.id);
    await approveRequest(db, {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: NOW,
    });
    const within = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-02"),
      checkOut: d("2027-03-05"),
      guests: 2,
      guest: { name: "Second Guest", email: "second@example.test" },
      idempotencyKey: randomUUID(),
      now: new Date(NOW.getTime() + 23 * HOUR),
    });
    expect(within).toMatchObject({ ok: false, reason: "UNAVAILABLE" });

    const after = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-02"),
      checkOut: d("2027-03-05"),
      guests: 2,
      guest: { name: "Second Guest", email: "second@example.test" },
      idempotencyKey: randomUUID(),
      now: new Date(NOW.getTime() + 25 * HOUR),
    });
    expect(after.ok).toBe(true);
    expect((await load(req.reservationId)).status).toBe("EXPIRED");
    expect(await templates(req.reservationId)).toContain(
      "payment_window_expired",
    );
  });
});
