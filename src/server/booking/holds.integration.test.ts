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
  type HoldInput,
} from "./holds";

const db = testDatabase(20);
afterAll(async () => db.$client.end());

// "Now" is fixed so dates and expiry are deterministic. Test data only.
const NOW = new Date("2026-10-08T12:00:00Z");
const MINUTE = 60_000;
/** Default owner response window for requests. */
const RESPONSE = 24 * 60 * MINUTE;

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
  it("creates a priced request that holds the dates until the owner's deadline", async () => {
    const property = await setupProperty();
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.kind).toBe("REQUEST");
    expect(result.quote.totalMinor).toBe(30_000);
    expect(result.holdExpiresAt.toISOString()).toBe("2026-10-09T12:00:00.000Z");
    expect(result.publicRef).toMatch(/^LL-[A-HJ-NP-Z2-9]{6}$/);

    const schedule = await db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, result.reservationId));
    expect(schedule.map((s) => [s.purpose, s.amountMinor, s.dueOn])).toEqual([
      ["DEPOSIT", 9_000, "2026-10-08"],
      ["BALANCE", 21_000, "2027-01-18"],
    ]);

    const [row] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationId));
    expect(row.status).toBe("REQUESTED");
    expect(row.approvedAt).toBeNull();
    expect(row.accessTokenHash).not.toBe(result.accessToken);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, result.reservationId));
    expect(audits.map((a) => a.action)).toEqual([
      "reservation.request_submitted",
    ]);
    const jobs = await db
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.reservationId, result.reservationId));
    expect(jobs.map((j) => [j.template, j.recipientKind]).sort()).toEqual([
      ["owner_new_request", "OWNER"],
      ["request_received", "GUEST"],
    ]);
  });

  it("uses the owner's configured response window", async () => {
    const property = await setupProperty({ requestResponseHours: 48 });
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!result.ok) throw new Error("expected request");
    expect(result.holdExpiresAt.toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });

  it("refuses instant bookings unless the owner has approved that mode", async () => {
    const property = await setupProperty({ bookingMode: "INSTANT" });
    vi.stubEnv("INSTANT_BOOKING_APPROVED", "false");
    expect(
      await createHold(db, input(property.id, "2027-03-01", "2027-03-04")),
    ).toEqual({ ok: false, reason: "BOOKINGS_DISABLED" });
    expect(await db.select().from(reservations)).toHaveLength(0);

    vi.stubEnv("INSTANT_BOOKING_APPROVED", "true");
    const result = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!result.ok) throw new Error("expected hold");
    expect(result.kind).toBe("INSTANT");
    expect(result.holdExpiresAt.toISOString()).toBe("2026-10-08T12:30:00.000Z");
    const [row] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, result.reservationId));
    expect(row.status).toBe("PENDING_PAYMENT");
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

  it("treats an expired request as free and marks it EXPIRED", async () => {
    const property = await setupProperty();
    const first = await createHold(
      db,
      input(property.id, "2027-03-01", "2027-03-04"),
    );
    if (!first.ok) throw new Error("expected hold");

    const later = new Date(NOW.getTime() + RESPONSE + MINUTE);
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

  it("does not free a request before it expires", async () => {
    const property = await setupProperty();
    await createHold(db, input(property.id, "2027-03-01", "2027-03-04"));
    const almost = new Date(NOW.getTime() + RESPONSE - MINUTE);
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

  it("lets exactly one of many simultaneous overlapping requests succeed", async () => {
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
  it("expires only lapsed requests, audits and notifies once", async () => {
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

    const at = new Date(NOW.getTime() + RESPONSE + 5 * MINUTE);
    const expired = await expireLapsedHolds(db, null, at);
    expect(expired).toEqual([a.reservationId]);
    expect(await expireLapsedHolds(db, null, at)).toEqual([]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, a.reservationId));
    expect(audits.map((x) => x.action)).toContain(
      "reservation.request_expired",
    );
    const jobs = await db
      .select({ template: notificationJobs.template })
      .from(notificationJobs)
      .where(eq(notificationJobs.reservationId, a.reservationId));
    expect(jobs.map((j) => j.template).sort()).toEqual(
      [
        "owner_new_request",
        "owner_request_expired",
        "request_expired",
        "request_received",
      ].sort(),
    );
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
    ).toEqual({
      ok: false,
      reason: "CONFLICTS_WITH_BOOKING",
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
