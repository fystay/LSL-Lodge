import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  auditLogs,
  externalBusyPeriods,
  externalCalendarSources,
  notificationJobs,
  paymentPolicies,
  paymentScheduleItems,
  properties,
  rateRules,
  reservations,
} from "@/server/db/schema";
import { resetTables, testDatabase } from "../../../tests/support/test-db";
import {
  createHold,
  createOwnerBlock,
  expireLapsedHolds,
  findReservationForGuest,
  removeOwnerBlock,
  updateOwnerBlock,
  type HoldInput,
} from "./holds";

const db = testDatabase(20);
afterAll(async () => db.$client.end());

// "Now" is fixed so dates and expiry are deterministic. Test data only.
const NOW = new Date("2026-10-08T12:00:00Z");
const MINUTE = 60_000;
/** How long an unpaid hold keeps the dates. */
const HOLD = 30 * MINUTE;

async function setupProperty(
  overrides: Partial<typeof properties.$inferInsert> = {},
) {
  const [property] = await db
    .insert(properties)
    .values({
      slug: `lodge-${randomUUID()}`,
      name: "Test lodge",
      maxGuests: 6,
      defaultMinNights: 2,
      bookingsEnabled: true,
      ...overrides,
    })
    .returning();
  await db.insert(rateRules).values({
    propertyId: property.id,
    name: "Test rate",
    startsOn: "2026-01-01",
    endsOn: "2028-01-01",
    nightlyMinor: 10_000,
  });
  await db.insert(paymentPolicies).values({
    propertyId: property.id,
    mode: "DEPOSIT",
    depositBasisPoints: 3_000,
    balanceDueDaysBeforeCheckIn: 42,
    fullPaymentWithinDays: 42,
  });
  return property;
}

const input = (
  propertyId: string,
  checkIn: string,
  checkOut: string,
  extra: Partial<HoldInput> = {},
): HoldInput => ({
  propertyId,
  checkIn: d(checkIn),
  checkOut: d(checkOut),
  guests: 2,
  guest: { name: "Test Guest", email: "guest@example.test" },
  idempotencyKey: randomUUID(),
  now: NOW,
  ...extra,
});

beforeEach(async () => resetTables(db));
afterEach(() => vi.unstubAllEnvs());

describe("createHold", () => {
  it("holds the dates for payment in full, with no approval step", async () => {
    // The stored plan is a deposit, but instant booking always takes the
    // full amount at booking.
    const property = await setupProperty();
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.totalMinor).toBe(30_000);
    expect(result.holdExpiresAt.toISOString()).toBe("2026-10-08T12:30:00.000Z");
    expect(result.publicRef).toMatch(/^LL-[A-HJ-NP-Z2-9]{6}$/);

    const schedule = await db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, result.reservationId));
    expect(schedule.map((s) => [s.purpose, s.amountMinor, s.dueOn])).toEqual([
      ["FULL", 30_000, "2026-10-08"],
    ]);

    const [row] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationId));
    expect(row.status).toBe("PENDING_PAYMENT");
    expect(row.requestedAt.toISOString()).toBe(NOW.toISOString());
    // The 24-hour window hasn't started: it starts at verified payment.
    expect(row.confirmedAt).toBeNull();
    expect(row.freeCancellationUntil).toBeNull();
    expect(row.cancellationPolicy).toBe(
      "FULL_REFUND_WITHIN_24H_OF_CONFIRMATION",
    );
    expect(row.accessTokenHash).not.toBe(result.accessToken);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, result.reservationId));
    expect(audits.map((a) => a.action)).toEqual(["reservation.hold_created"]);
    // Nothing is emailed until payment is verified.
    expect(
      await db
        .select()
        .from(notificationJobs)
        .where(eq(notificationJobs.reservationId, result.reservationId)),
    ).toHaveLength(0);
  });

  it("lets the confirmation time and deadline be set once, consistently, and never moved", async () => {
    const property = await setupProperty();
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!result.ok) throw new Error("expected hold");
    const byId = eq(reservations.id, result.reservationId);
    const confirmedAt = new Date("2026-10-08T12:10:00Z");
    // A deadline that isn't confirmed_at + 24 h is refused by the database.
    await expect(
      db
        .update(reservations)
        .set({
          confirmedAt,
          freeCancellationUntil: new Date("2026-10-09T12:00:00Z"),
        })
        .where(byId),
    ).rejects.toThrow();
    await db
      .update(reservations)
      .set({
        confirmedAt,
        freeCancellationUntil: new Date("2026-10-09T12:10:00Z"),
      })
      .where(byId);
    for (const change of [
      { requestedAt: new Date() },
      { confirmedAt: new Date("2026-10-08T14:00:00Z") },
      { confirmedAt: null },
      { freeCancellationUntil: new Date("2030-01-01T00:00:00Z") },
      { freeCancellationUntil: null },
      { cancellationPolicy: "SOMETHING_ELSE" },
    ])
      await expect(
        db.update(reservations).set(change).where(byId),
      ).rejects.toThrow();
    const [row] = await db.select().from(reservations).where(byId);
    expect(row.freeCancellationUntil?.toISOString()).toBe(
      "2026-10-09T12:10:00.000Z",
    );
  });

  it("lets the guest find the booking only with the right token", async () => {
    const property = await setupProperty();
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!result.ok) throw new Error("expected hold");
    expect(
      await findReservationForGuest(db, result.publicRef, result.accessToken),
    ).not.toBeNull();
    expect(
      await findReservationForGuest(db, result.publicRef, "wrong-token"),
    ).toBeNull();
  });

  it("refuses dates that overlap an existing hold", async () => {
    const property = await setupProperty();
    expect(
      (await createHold(db, input(property.id, "2027-03-01", "2027-03-04"))).ok,
    ).toBe(true);
    const second = await createHold(
      db,
      input(property.id, "2027-03-03", "2027-03-06"),
    );
    expect(second).toMatchObject({ ok: false, reason: "UNAVAILABLE" });
  });

  it("allows same-day turnover, but not inside a configured buffer", async () => {
    const property = await setupProperty();
    await createHold(db, input(property.id, "2027-03-01", "2027-03-04"));
    expect(
      (await createHold(db, input(property.id, "2027-03-04", "2027-03-06"))).ok,
    ).toBe(true);

    const buffered = await setupProperty({ turnoverNights: 1 });
    await createHold(db, input(buffered.id, "2027-03-01", "2027-03-04"));
    expect(
      await createHold(db, input(buffered.id, "2027-03-04", "2027-03-06")),
    ).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
    expect(
      (await createHold(db, input(buffered.id, "2027-03-05", "2027-03-07"))).ok,
    ).toBe(true);
  });

  it("treats an expired hold as free and marks it EXPIRED", async () => {
    const property = await setupProperty();
    const first = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!first.ok) throw new Error("expected hold");

    const later = new Date(NOW.getTime() + HOLD + MINUTE);
    const second = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04", { now: later }),
    );
    expect(second.ok).toBe(true);

    const [old] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, first.reservationId));
    expect(old.status).toBe("EXPIRED");
  });

  it("does not free a hold before it expires", async () => {
    const property = await setupProperty();
    await createHold(db, input(property.id, "2027-03-01", "2027-03-04"));
    const almost = new Date(NOW.getTime() + HOLD - MINUTE);
    expect(
      await createHold(
        db,
        input(property.id, "2027-03-01", "2027-03-04", { now: almost }),
      ),
    ).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("is blocked by owner blocks and imported external busy periods", async () => {
    const property = await setupProperty();
    await createOwnerBlock(db, {
      propertyId: property.id,
      startsOn: d("2027-04-01"),
      endsOn: d("2027-04-05"),
      reason: "Maintenance",
      createdBy: "owner@example.test",
      now: NOW,
    });
    expect(
      await createHold(db, input(property.id, "2027-04-03", "2027-04-06")),
    ).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });

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
      externalUid: "uid-1@airbnb.test",
      startsOn: "2027-05-10",
      endsOn: "2027-05-12",
      contentHash: "h",
    });
    expect(
      await createHold(db, input(property.id, "2027-05-11", "2027-05-14")),
    ).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });

  it("replays a duplicate submission instead of creating a second hold", async () => {
    const property = await setupProperty();
    const request = input(property.id, "2027-03-01", "2027-03-04");
    const first = await createHold(db, request);
    const again = await createHold(db, request);
    if (!first.ok || !again.ok) throw new Error("expected holds");
    expect(again.replayed).toBe(true);
    expect(again.reservationId).toBe(first.reservationId);
    // Tokens rotate on replay; the newest one works.
    expect(
      await findReservationForGuest(db, again.publicRef, again.accessToken),
    ).not.toBeNull();

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations);
    expect(count).toBe(1);
  });

  it("rejects reuse of an idempotency key for a different stay", async () => {
    const property = await setupProperty();
    const key = randomUUID();
    await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04", { idempotencyKey: key }),
    );
    expect(
      await createHold(
        db,
        input(property.id, "2027-06-01", "2027-06-04", { idempotencyKey: key }),
      ),
    ).toEqual({ ok: false, reason: "IDEMPOTENCY_MISMATCH" });
  });

  it("refuses when bookings are disabled, and reports pricing problems", async () => {
    const closed = await setupProperty({ bookingsEnabled: false });
    expect(
      await createHold(db, input(closed.id, "2027-03-01", "2027-03-04")),
    ).toEqual({
      ok: false,
      reason: "BOOKINGS_DISABLED",
    });
    const open = await setupProperty();
    expect(
      await createHold(db, input(open.id, "2027-03-01", "2027-03-02")),
    ).toEqual({
      ok: false,
      reason: "QUOTE",
      error: { code: "MIN_NIGHTS", minNights: 2 },
    });
    expect(
      await createHold(db, input(open.id, "2028-03-01", "2028-03-04")),
    ).toMatchObject({
      ok: false,
      reason: "QUOTE",
      error: { code: "NO_RATE" },
    });
  });

  it("lets exactly one of many simultaneous overlapping bookings succeed", async () => {
    const property = await setupProperty();
    const attempts = 12;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        createHold(
          db,
          input(property.id, `2027-07-0${1 + (i % 3)}`, "2027-07-06"),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.reason === "UNAVAILABLE"),
    ).toHaveLength(attempts - 1);
  });
});

describe("expireLapsedHolds", () => {
  it("expires only lapsed holds, and audits once", async () => {
    const property = await setupProperty();
    const a = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    const b = await createHold(
      db,
      input(property.id, "2027-03-10", "2027-03-13", {
        now: new Date(NOW.getTime() + 20 * 60_000),
      }),
    );
    if (!a.ok || !b.ok) throw new Error("expected holds");

    const at = new Date(NOW.getTime() + HOLD + 5 * MINUTE);
    const expired = await expireLapsedHolds(db, null, at);
    expect(expired).toEqual([a.reservationId]);
    expect(await expireLapsedHolds(db, null, at)).toEqual([]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, a.reservationId));
    expect(audits.map((x) => x.action)).toEqual([
      "reservation.hold_created",
      "reservation.hold_expired",
    ]);
  });
});

describe("owner blocks", () => {
  it("refuses to cover an existing booking, and can be removed", async () => {
    const property = await setupProperty();
    await createHold(db, input(property.id, "2027-03-01", "2027-03-04"));
    const base = {
      propertyId: property.id,
      reason: null,
      createdBy: "owner@example.test",
      now: NOW,
    };
    expect(
      await createOwnerBlock(db, {
        ...base,
        startsOn: d("2027-03-02"),
        endsOn: d("2027-03-05"),
      }),
    ).toMatchObject({
      ok: false,
      reason: "CONFLICTS_WITH_BOOKING",
      bookings: [{ checkIn: "2027-03-01", checkOut: "2027-03-04" }],
    });
    const ok = await createOwnerBlock(db, {
      ...base,
      startsOn: d("2027-03-04"),
      endsOn: d("2027-03-08"),
    });
    if (!ok.ok) throw new Error("expected block");

    expect(
      await createHold(db, input(property.id, "2027-03-05", "2027-03-07")),
    ).toMatchObject({ ok: false });
    expect(await removeOwnerBlock(db, ok.id, "owner@example.test")).toBe(true);
    expect(await removeOwnerBlock(db, ok.id, "owner@example.test")).toBe(false);
    expect(
      (await createHold(db, input(property.id, "2027-03-05", "2027-03-07"))).ok,
    ).toBe(true);
  });
});

describe("owner block lifecycle", () => {
  const base = (propertyId: string) => ({
    propertyId,
    createdBy: "owner@example.test",
    now: NOW,
  });

  it("edits a block, refusing a range that would cover a booking, and audits every step", async () => {
    const property = await setupProperty();
    const hold = await createHold(
      db,
      input(property.id, "2027-03-10", "2027-03-12"),
    );
    if (!hold.ok) throw new Error("expected hold");
    const block = await createOwnerBlock(db, {
      ...base(property.id),
      startsOn: d("2027-03-01"),
      endsOn: d("2027-03-05"),
      reason: "Family",
    });
    if (!block.ok) throw new Error("expected block");

    const edit = (startsOn: string, endsOn: string, reason: string | null) =>
      updateOwnerBlock(db, {
        propertyId: property.id,
        id: block.id,
        startsOn: d(startsOn),
        endsOn: d(endsOn),
        reason,
        actor: "owner@example.test",
        now: NOW,
      });
    expect(await edit("2027-03-01", "2027-03-11", "Family")).toMatchObject({
      ok: false,
      reason: "CONFLICTS_WITH_BOOKING",
      bookings: [{ publicRef: hold.publicRef }],
    });
    expect(await edit("2027-03-02", "2027-03-08", "Painting")).toEqual({
      ok: true,
      id: block.id,
    });
    expect(await edit("2027-03-08", "2027-03-02", null)).toEqual({
      ok: false,
      reason: "INVALID_RANGE",
    });
    expect(await removeOwnerBlock(db, block.id, "owner@example.test")).toBe(
      true,
    );
    expect(await edit("2027-03-02", "2027-03-08", null)).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, block.id))
      .orderBy(auditLogs.createdAt);
    expect(audits.map((a) => a.action)).toEqual([
      "owner_block.created",
      "owner_block.updated",
      "owner_block.removed",
    ]);
    expect(audits[1].metadata).toEqual({
      before: {
        startsOn: "2027-03-01",
        endsOn: "2027-03-05",
        reason: "Family",
      },
      after: {
        startsOn: "2027-03-02",
        endsOn: "2027-03-08",
        reason: "Painting",
      },
    });
    expect(audits[2].actorId).toBe("owner@example.test");
  });

  it("lets an Airbnb import and an owner block overlap (both just block)", async () => {
    const property = await setupProperty();
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
      externalUid: "uid-2@airbnb.test",
      startsOn: "2027-05-10",
      endsOn: "2027-05-12",
      contentHash: "h",
    });
    expect(
      (
        await createOwnerBlock(db, {
          ...base(property.id),
          startsOn: d("2027-05-09"),
          endsOn: d("2027-05-11"),
          reason: null,
        })
      ).ok,
    ).toBe(true);
  });

  it("does not treat a lapsed hold as a booking in the way", async () => {
    const property = await setupProperty();
    await createHold(db, input(property.id, "2027-03-01", "2027-03-04"));
    expect(
      (
        await createOwnerBlock(db, {
          ...base(property.id),
          now: new Date(NOW.getTime() + HOLD + MINUTE),
          startsOn: d("2027-03-01"),
          endsOn: d("2027-03-04"),
          reason: null,
        })
      ).ok,
    ).toBe(true);
  });
});
