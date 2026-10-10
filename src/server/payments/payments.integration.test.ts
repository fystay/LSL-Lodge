import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  externalBusyPeriods,
  externalCalendarSources,
  notificationJobs,
  paymentScheduleItems,
  payments,
  reservations,
  webhookEvents,
} from "@/server/db/schema";
import { createHold, expireLapsedHolds } from "@/server/booking/holds";
import {
  confirmReviewedBooking,
  guestCancel,
} from "@/server/booking/resolution";
import { auditLogs } from "@/server/db/schema";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { applyCheckoutSession, startCheckout } from "./checkout";
import { verifyStripeWebhook } from "./stripe-webhook";
import { processStripeEvent } from "./webhook";

const db = testDatabase(20);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Test data and test-mode-shaped identifiers only. No network calls.
const NOW = new Date("2026-10-08T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = "http://localhost:3000";

/** Unpaid holds last 30 minutes; this is safely past that. */
const LAPSED = 40 * MIN;

/** A guest's instant booking, held for payment (no approval step). */
async function heldBooking(
  overrides: Parameters<typeof createBookableProperty>[1] = {},
  stay: [string, string] = ["2027-03-01", "2027-03-04"],
) {
  const property = await createBookableProperty(db, overrides);
  const hold = await createHold(db, {
    propertyId: property.id,
    checkIn: d(stay[0]),
    checkOut: d(stay[1]),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
    now: NOW,
  });
  if (!hold.ok) throw new Error("expected hold");
  return { property, reservationId: hold.reservationId };
}

const load = async (id: string) =>
  (await db.select().from(reservations).where(eq(reservations.id, id)))[0];
const paymentRows = (id: string) =>
  db.select().from(payments).where(eq(payments.reservationId, id));
const templates = async (id: string) =>
  (
    await db
      .select({ t: notificationJobs.template })
      .from(notificationJobs)
      .where(eq(notificationJobs.reservationId, id))
  ).map((r) => r.t);

describe("startCheckout", () => {
  it("creates one server-priced session for the full amount, inside the hold", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    const at = new Date(NOW.getTime() + 5 * MIN);
    const result = await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: at,
    });
    expect(result).toMatchObject({ ok: true, reused: false });

    const [params] = gateway.created;
    expect(params.amountMinor).toBe(30_000);
    expect(params.currency).toBe("GBP");
    expect(params.reservationId).toBe(reservationId);
    expect(params.successUrl).toContain("{CHECKOUT_SESSION_ID}");
    // The 24-hour cancellation deadline is shown on Stripe's page.
    // No deadline exists before payment is confirmed, so none is quoted.
    expect(params.submitMessage).toBe(
      "The 24-hour free-cancellation period starts once your payment is confirmed. After that, the booking is non-refundable.",
    );
    expect(params.submitMessage).not.toMatch(/\d:\d\d/);
    const r = await load(reservationId);
    expect(params.expiresAt.getTime()).toBeLessThanOrEqual(
      r.holdExpiresAt!.getTime(),
    );
    expect(params.expiresAt.getTime() - at.getTime()).toBeLessThanOrEqual(
      24 * HOUR,
    );

    const [payment] = await paymentRows(reservationId);
    expect(payment).toMatchObject({
      status: "PENDING",
      purpose: "FULL",
      amountMinor: 30_000,
      stripeCheckoutSessionId: gateway.latest().id,
    });
  });

  it("reuses the open session instead of creating a second one", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    const args = { reservationId, baseUrl: BASE, now: NOW };
    const first = await startCheckout(db, gateway, args);
    const second = await startCheckout(db, gateway, args);
    expect(second).toEqual({
      ok: true,
      url: first.ok ? first.url : "",
      reused: true,
    });
    expect(gateway.created).toHaveLength(1);
  });

  it("never charges a released or lapsed hold", async () => {
    const gateway = new FakeGateway();
    const { property, reservationId } = await heldBooking();
    expect(
      await guestCancel(db, { propertyId: property.id, reservationId }),
    ).toMatchObject({ ok: true, outcome: "HOLD_RELEASED" });
    expect(
      await startCheckout(db, gateway, {
        reservationId,
        baseUrl: BASE,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "NOT_PAYABLE" });

    const lapsed = await heldBooking({}, ["2027-05-01", "2027-05-04"]);
    expect(
      await startCheckout(db, gateway, {
        reservationId: lapsed.reservationId,
        baseUrl: BASE,
        now: new Date(NOW.getTime() + LAPSED),
      }),
    ).toEqual({ ok: false, reason: "EXPIRED" });
    expect(gateway.created).toHaveLength(0);
  });

  it("extends the hold to cover a session started near the deadline", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    const at = new Date(NOW.getTime() + 25 * MIN); // 10 minutes left
    await startCheckout(db, gateway, { reservationId, baseUrl: BASE, now: at });
    const session = gateway.latest();
    expect(session.expiresAt.getTime() - at.getTime()).toBe(31 * MIN);
    expect((await load(reservationId)).holdExpiresAt).toEqual(
      session.expiresAt,
    );
  });

  it("refuses payment if another calendar now overlaps the stay", async () => {
    const { property, reservationId } = await heldBooking();
    await importBusy(property.id, "2027-03-02", "2027-03-03");
    expect(
      await startCheckout(db, new FakeGateway(), {
        reservationId,
        baseUrl: BASE,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });
});

describe("applyCheckoutSession", () => {
  it("confirms an instant booking only on verified full payment", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const session = gateway.latest();

    // Opened but unpaid: nothing changes.
    expect(await applyCheckoutSession(db, session, NOW)).toBe(
      "ALREADY_APPLIED",
    );
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");

    const paid = gateway.pay(session.id);
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("CONFIRMED");
    const r = await load(reservationId);
    expect(r.status).toBe("CONFIRMED");
    expect(r.holdExpiresAt).toBeNull();
    const [payment] = await paymentRows(reservationId);
    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.stripePaymentIntentId).toMatch(/^pi_test_/);
    const schedule = await db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, reservationId));
    expect(schedule.map((s) => [s.status, s.paidMinor])).toEqual([
      ["PAID", 30_000],
    ]);
    expect(await templates(reservationId)).toEqual(
      expect.arrayContaining(["booking_confirmed", "owner_booking_confirmed"]),
    );

    // Applying again (a duplicate or retried delivery) changes nothing.
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("ALREADY_APPLIED");
    expect(await paymentRows(reservationId)).toHaveLength(1);
  });

  it("sends an amount mismatch to the owner instead of confirming", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const paid = gateway.pay(gateway.latest().id, { amountTotal: 100 });
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("MISMATCH");
    const r = await load(reservationId);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect(r.reviewReason).toBe("AMOUNT_MISMATCH");
    expect(await templates(reservationId)).toContain(
      "owner_payment_needs_review",
    );
  });

  it("ignores a session that belongs to another reservation or payment", async () => {
    const { reservationId } = await heldBooking();
    const other = await heldBooking({}, ["2027-06-01", "2027-06-04"]);
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const paid = gateway.pay(gateway.latest().id);

    expect(
      await applyCheckoutSession(
        db,
        { ...paid, clientReferenceId: other.reservationId },
        NOW,
      ),
    ).toBe("UNKNOWN_SESSION");
    expect(
      await applyCheckoutSession(
        db,
        { ...paid, metadata: { ...paid.metadata, payment_id: randomUUID() } },
        NOW,
      ),
    ).toBe("UNKNOWN_SESSION");
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");
    expect((await load(other.reservationId)).status).toBe("PENDING_PAYMENT");
  });

  it("routes a payment that lands after expiry to review if the dates are still free", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await expireLapsedHolds(db, null, new Date(NOW.getTime() + LAPSED));
    expect((await load(reservationId)).status).toBe("EXPIRED");

    const paid = gateway.pay(gateway.latest().id);
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("NEEDS_REVIEW");
    const r = await load(reservationId);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect(r.reviewReason).toBe("PAYMENT_AFTER_EXPIRY");
    expect((await paymentRows(reservationId))[0].status).toBe("SUCCEEDED");
  });

  it("flags a refund when a late payment's dates were re-booked", async () => {
    const { property, reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const later = new Date(NOW.getTime() + LAPSED);
    const rebooked = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-01"),
      checkOut: d("2027-03-04"),
      guests: 2,
      guest: { name: "Second Guest", email: "second@example.test" },
      idempotencyKey: randomUUID(),
      now: later,
    });
    expect(rebooked.ok).toBe(true);

    const paid = gateway.pay(gateway.latest().id);
    expect(await applyCheckoutSession(db, paid, later)).toBe("REFUND_REQUIRED");
    const r = await load(reservationId);
    expect(r.status).toBe("EXPIRED");
    expect(r.reviewReason).toBe("PAYMENT_AFTER_EXPIRY_REFUND_REQUIRED");
    // The money is recorded, never lost, and is refunded automatically.
    const rows = await paymentRows(reservationId);
    expect(rows.find((p) => p.kind === "CHARGE")?.status).toBe("SUCCEEDED");
    expect(
      rows
        .filter((p) => p.kind === "REFUND")
        .map((p) => [p.status, p.amountMinor, p.initiatedBy]),
    ).toEqual([["PENDING", 30_000, "AUTO_PAYMENT_AFTER_EXPIRY"]]);
  });

  it("refunds in full, automatically, a payment that lands after the guest cancelled", async () => {
    const { property, reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const session = gateway.latest();
    // The guest released the hold in another tab while Stripe was open.
    await db
      .update(payments)
      .set({ status: "PENDING" })
      .where(eq(payments.reservationId, reservationId));
    await guestCancel(db, { propertyId: property.id, reservationId });
    expect((await load(reservationId)).status).toBe("CANCELLED");

    expect(await applyCheckoutSession(db, gateway.pay(session.id), NOW)).toBe(
      "REFUND_REQUIRED",
    );
    // Still cancelled; now tracked until Stripe confirms the refund.
    expect((await load(reservationId)).status).toBe("REFUND_PENDING");
    const refunds = (await paymentRows(reservationId)).filter(
      (p) => p.kind === "REFUND",
    );
    expect(refunds.map((p) => [p.status, p.amountMinor])).toEqual([
      ["PENDING", 30_000],
    ]);
    expect(await templates(reservationId)).toContain(
      "owner_payment_needs_review",
    );
  });

  it("does not confirm if an imported calendar overlaps by the time payment lands", async () => {
    const { property, reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await importBusy(property.id, "2027-03-03", "2027-03-05");
    const paid = gateway.pay(gateway.latest().id);
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("NEEDS_REVIEW");
    expect((await load(reservationId)).reviewReason).toBe("CALENDAR_CONFLICT");
  });

  it("keeps a confirmed booking confirmed when a second payment arrives, and flags a refund", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const first = gateway.latest();
    // A second session for the same booking (e.g. two tabs), both paid.
    await db
      .update(payments)
      .set({ checkoutExpiresAt: NOW })
      .where(eq(payments.stripeCheckoutSessionId, first.id));
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const second = gateway.latest();
    expect(second.id).not.toBe(first.id);

    expect(await applyCheckoutSession(db, gateway.pay(first.id), NOW)).toBe(
      "CONFIRMED",
    );
    expect(await applyCheckoutSession(db, gateway.pay(second.id), NOW)).toBe(
      "REFUND_REQUIRED",
    );
    const r = await load(reservationId);
    expect(r.status).toBe("CONFIRMED");
    expect(r.reviewReason).toBe("DUPLICATE_PAYMENT_REFUND_REQUIRED");
    const rows = await paymentRows(reservationId);
    expect(
      rows.filter((p) => p.kind === "CHARGE" && p.status === "SUCCEEDED"),
    ).toHaveLength(2);
    const duplicate = rows.find((p) => p.stripeCheckoutSessionId === second.id);
    expect(duplicate?.failureCode).toBe("DUPLICATE_PAYMENT_REFUND_REQUIRED");
    // The duplicate (only) is queued for an automatic full refund.
    expect(
      rows
        .filter((p) => p.kind === "REFUND")
        .map((p) => [p.refundOfPaymentId, p.amountMinor, p.status]),
    ).toEqual([[duplicate?.id, 30_000, "PENDING"]]);
  });

  it("still applies a paid session whose ID wasn't saved", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await db
      .update(payments)
      .set({ stripeCheckoutSessionId: null })
      .where(eq(payments.reservationId, reservationId));
    expect(
      await applyCheckoutSession(db, gateway.pay(gateway.latest().id), NOW),
    ).toBe("CONFIRMED");
    expect((await paymentRows(reservationId))[0].stripeCheckoutSessionId).toBe(
      gateway.latest().id,
    );
  });

  it("alerts the owner once per problem payment, not once per booking", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const first = gateway.latest();
    await db
      .update(payments)
      .set({ checkoutExpiresAt: NOW })
      .where(eq(payments.stripeCheckoutSessionId, first.id));
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const second = gateway.latest();
    await applyCheckoutSession(
      db,
      gateway.pay(first.id, { amountTotal: 1 }),
      NOW,
    );
    await applyCheckoutSession(
      db,
      gateway.pay(second.id, { amountTotal: 1 }),
      NOW,
    );
    expect(
      (await templates(reservationId)).filter(
        (t) => t === "owner_payment_needs_review",
      ),
    ).toHaveLength(2);
  });

  it("marks an expired session's payment cancelled and keeps the hold", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await gateway.expireCheckoutSession(gateway.latest().id);
    expect(await applyCheckoutSession(db, gateway.latest(), NOW)).toBe(
      "SESSION_EXPIRED",
    );
    expect((await paymentRows(reservationId))[0].status).toBe("CANCELED");
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");

    // The guest can try again with a fresh session.
    const retry = await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    expect(retry).toMatchObject({ ok: true, reused: false });
  });
});

describe("Stripe webhook events", () => {
  // Offline: a dummy test key is only used to build and sign payloads locally.
  const stripe = new Stripe("sk_test_dummy_not_a_real_key");
  const secret = "whsec_test_secret_for_integration_tests";

  function signedEvent(
    type: string,
    session: ReturnType<FakeGateway["latest"]>,
    id = `evt_test_${randomUUID().replaceAll("-", "")}`,
  ) {
    const payload = JSON.stringify({
      id,
      object: "event",
      type,
      data: {
        object: {
          id: session.id,
          object: "checkout.session",
          status: session.status,
          payment_status: session.paymentStatus,
          amount_total: session.amountTotal,
          currency: session.currency,
          client_reference_id: session.clientReferenceId,
          payment_intent: session.paymentIntentId,
          metadata: session.metadata,
          url: null,
          expires_at: Math.floor(session.expiresAt.getTime() / 1000),
        },
      },
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    return verifyStripeWebhook(stripe, payload, header, secret);
  }

  it("confirms once from a verified event and acknowledges duplicates", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const event = signedEvent(
      "checkout.session.completed",
      gateway.pay(gateway.latest().id),
    );

    expect(await processStripeEvent(db, event, NOW)).toEqual({
      handled: "applied",
      type: "checkout.session.completed",
      outcome: "CONFIRMED",
    });
    expect(await processStripeEvent(db, event, NOW)).toEqual({
      handled: "duplicate",
    });
    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("PROCESSED");
    expect(
      (await templates(reservationId)).filter((t) => t === "booking_confirmed"),
    ).toHaveLength(1);
  });

  it("handles out-of-order delivery: expired after completed changes nothing", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const paid = gateway.pay(gateway.latest().id);
    await processStripeEvent(
      db,
      signedEvent("checkout.session.completed", paid),
      NOW,
    );
    const late = await processStripeEvent(
      db,
      signedEvent("checkout.session.expired", { ...paid, status: "expired" }),
      NOW,
    );
    expect(late).toMatchObject({ outcome: "ALREADY_APPLIED" });
    expect((await load(reservationId)).status).toBe("CONFIRMED");
  });

  it("concurrent duplicate deliveries apply exactly once", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const event = signedEvent(
      "checkout.session.completed",
      gateway.pay(gateway.latest().id),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => processStripeEvent(db, event, NOW)),
    );
    expect(results.filter((r) => r.handled === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.handled === "duplicate")).toHaveLength(4);
    expect((await load(reservationId)).status).toBe("CONFIRMED");
  });

  it("records an async payment failure and tells the guest", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const session = gateway.latest();
    await processStripeEvent(
      db,
      signedEvent("checkout.session.async_payment_failed", session),
      NOW,
    );
    expect((await paymentRows(reservationId))[0].status).toBe("FAILED");
    expect(await templates(reservationId)).toContain("payment_failed");
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");
  });

  it("ignores unrelated event types but records them", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    expect(
      await processStripeEvent(
        db,
        signedEvent("customer.created", gateway.latest()),
        NOW,
      ),
    ).toEqual({ handled: "ignored", type: "customer.created" });
  });
});

async function importBusy(
  propertyId: string,
  startsOn: string,
  endsOn: string,
) {
  const [source] = await db
    .insert(externalCalendarSources)
    .values({
      propertyId,
      provider: "AIRBNB_ICAL",
      direction: "IMPORT",
      label: "Airbnb",
    })
    .returning();
  await db.insert(externalBusyPeriods).values({
    sourceId: source.id,
    propertyId,
    externalUid: `uid-${randomUUID()}`,
    startsOn,
    endsOn,
    contentHash: "h",
  });
}

describe("free-cancellation clock (starts at verified payment)", () => {
  const stripe = new Stripe("sk_test_dummy_not_a_real_key");
  const secret = "whsec_test_secret_for_clock_tests";
  const completed = (session: ReturnType<FakeGateway["latest"]>) => {
    const payload = JSON.stringify({
      id: `evt_test_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: session.id,
          object: "checkout.session",
          status: session.status,
          payment_status: session.paymentStatus,
          amount_total: session.amountTotal,
          currency: session.currency,
          client_reference_id: session.clientReferenceId,
          payment_intent: session.paymentIntentId,
          metadata: session.metadata,
          url: null,
          expires_at: Math.floor(session.expiresAt.getTime() / 1000),
        },
      },
    });
    return verifyStripeWebhook(
      stripe,
      payload,
      stripe.webhooks.generateTestHeaderString({ payload, secret }),
      secret,
    );
  };
  const clock = async (id: string) => {
    const r = await load(id);
    return {
      requestedAt: r.requestedAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      freeCancellationUntil: r.freeCancellationUntil?.toISOString() ?? null,
    };
  };
  const plus = (ms: number) => new Date(NOW.getTime() + ms);

  it("has no deadline while the guest is still paying", async () => {
    const { reservationId } = await heldBooking();
    await startCheckout(db, new FakeGateway(), {
      reservationId,
      baseUrl: BASE,
      now: plus(5 * MIN),
    });
    expect(await clock(reservationId)).toEqual({
      requestedAt: NOW.toISOString(),
      confirmedAt: null,
      freeCancellationUntil: null,
    });
  });

  it("starts the 24 hours when the verified webhook confirms, not when the booking or Checkout began", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: plus(5 * MIN),
    });
    const verifiedAt = plus(20 * MIN);
    expect(
      await processStripeEvent(
        db,
        completed(gateway.pay(gateway.latest().id)),
        verifiedAt,
      ),
    ).toMatchObject({ outcome: "CONFIRMED" });
    expect(await clock(reservationId)).toEqual({
      requestedAt: NOW.toISOString(),
      confirmedAt: verifiedAt.toISOString(),
      freeCancellationUntil: plus(20 * MIN + 24 * HOUR).toISOString(),
    });
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "reservation.confirmed"));
    expect(entry.metadata).toMatchObject({
      confirmedAt: verifiedAt.toISOString(),
      freeCancellationUntil: plus(20 * MIN + 24 * HOUR).toISOString(),
    });
  });

  it("is not reset by a duplicate, delayed or out-of-order webhook", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const paid = gateway.pay(gateway.latest().id);
    // The guest's return page verifies the session with Stripe first.
    const returnedAt = plus(3 * MIN);
    expect(await applyCheckoutSession(db, paid, returnedAt)).toBe("CONFIRMED");
    const first = await clock(reservationId);
    expect(first.freeCancellationUntil).toBe(
      plus(3 * MIN + 24 * HOUR).toISOString(),
    );
    // The webhook arrives two hours late, then again (a retry), then an
    // "expired" event out of order: none moves the deadline.
    const event = completed(paid);
    await processStripeEvent(db, event, plus(2 * HOUR));
    await processStripeEvent(db, event, plus(3 * HOUR));
    await processStripeEvent(
      db,
      completed({ ...paid, status: "expired" }),
      plus(4 * HOUR),
    );
    expect(await applyCheckoutSession(db, paid, plus(5 * HOUR))).toBe(
      "ALREADY_APPLIED",
    );
    expect(await clock(reservationId)).toEqual(first);
  });

  it("uses the delayed webhook's time when that is the first verification", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    // Paid at Stripe within the hold, but no return-page check and the
    // webhook only reaches us 50 minutes later.
    const lateArrival = plus(50 * MIN);
    await processStripeEvent(
      db,
      completed(gateway.pay(gateway.latest().id)),
      lateArrival,
    );
    // Nobody else had taken the dates, so it confirms on arrival, and the
    // 24 hours run from then (the server's verification time).
    expect(await clock(reservationId)).toMatchObject({
      confirmedAt: lateArrival.toISOString(),
      freeCancellationUntil: plus(50 * MIN + 24 * HOUR).toISOString(),
    });
  });

  it("starts the 24 hours when the owner confirms a payment that needed review", async () => {
    const { reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await expireLapsedHolds(db, null, plus(LAPSED));
    await processStripeEvent(
      db,
      completed(gateway.pay(gateway.latest().id)),
      plus(LAPSED + MIN),
    );
    const r = await load(reservationId);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect([r.confirmedAt, r.freeCancellationUntil]).toEqual([null, null]);

    const ownerConfirms = plus(3 * HOUR);
    expect(
      await confirmReviewedBooking(db, {
        propertyId: r.propertyId,
        reservationId,
        actor: "owner@example.test",
        now: ownerConfirms,
      }),
    ).toEqual({ ok: true });
    expect(await clock(reservationId)).toMatchObject({
      confirmedAt: ownerConfirms.toISOString(),
      freeCancellationUntil: plus(3 * HOUR + 24 * HOUR).toISOString(),
    });
  });

  it("keeps the original deadline if a confirmed booking is reviewed and confirmed again", async () => {
    const { property, reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await applyCheckoutSession(db, gateway.pay(gateway.latest().id), plus(MIN));
    const first = await clock(reservationId);
    await db
      .update(reservations)
      .set({ status: "REQUIRES_REVIEW", reviewReason: "CALENDAR_CONFLICT" })
      .where(eq(reservations.id, reservationId));
    await confirmReviewedBooking(db, {
      propertyId: property.id,
      reservationId,
      actor: "owner@example.test",
      now: plus(10 * HOUR),
    });
    expect(await clock(reservationId)).toEqual(first);
  });
});

describe("payment arriving while an imported calendar is stale", () => {
  it("goes to the owner for review instead of confirming, and the owner can then confirm it", async () => {
    const { property, reservationId } = await heldBooking();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    // The Airbnb feed went quiet after the guest started paying.
    await db.insert(externalCalendarSources).values({
      propertyId: property.id,
      provider: "AIRBNB_ICAL",
      direction: "IMPORT",
      label: "Airbnb",
      syncStatus: "ERROR",
      lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    expect(
      await applyCheckoutSession(db, gateway.pay(gateway.latest().id), NOW),
    ).toBe("NEEDS_REVIEW");
    const r = await load(reservationId);
    expect([r.status, r.reviewReason, r.confirmedAt]).toEqual([
      "REQUIRES_REVIEW",
      "CALENDAR_STALE",
      null,
    ]);
    // The dates stay held for this guest; the money is recorded.
    expect((await paymentRows(reservationId))[0].status).toBe("SUCCEEDED");
    expect(await templates(reservationId)).toContain(
      "owner_payment_needs_review",
    );

    const checked = new Date(NOW.getTime() + HOUR);
    expect(
      await confirmReviewedBooking(db, {
        propertyId: property.id,
        reservationId,
        actor: "owner@example.test",
        now: checked,
      }),
    ).toEqual({ ok: true });
    const after = await load(reservationId);
    expect(after.status).toBe("CONFIRMED");
    expect(after.freeCancellationUntil?.toISOString()).toBe(
      new Date(checked.getTime() + 24 * HOUR).toISOString(),
    );
  });

  it("won't start Checkout while a calendar is stale", async () => {
    const { property, reservationId } = await heldBooking();
    await db.insert(externalCalendarSources).values({
      propertyId: property.id,
      provider: "AIRBNB_ICAL",
      direction: "IMPORT",
      label: "Airbnb",
    });
    expect(
      await startCheckout(db, new FakeGateway(), {
        reservationId,
        baseUrl: BASE,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });
});
