import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  auditLogs,
  notificationJobs,
  payments,
  reservations,
} from "@/server/db/schema";
import { createHold, expireLapsedHolds } from "@/server/booking/holds";
import {
  cancelByOwner,
  confirmReviewedBooking,
  guestCancel,
  markFlagResolved,
} from "@/server/booking/resolution";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { applyCheckoutSession, startCheckout } from "./checkout";
import {
  REFUND_MAX_ATTEMPTS,
  issueRefund,
  processPendingRefunds,
  sendRefund,
} from "./refunds";
import { verifyStripeWebhook } from "./stripe-webhook";
import { processStripeEvent } from "./webhook";

const db = testDatabase(20);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Synthetic data only; the gateway is in memory.
const NOW = new Date("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
/** Unpaid holds last 35 minutes; this is safely past that. */
const LAPSED = 40 * 60_000;
/** The free-cancellation deadline for a booking requested at NOW. */
const DEADLINE = new Date(NOW.getTime() + 24 * HOUR);
const OWNER = "owner@example.test";
const BASE = "http://localhost:3000";

async function request(
  propertyId: string,
  stay = ["2027-03-01", "2027-03-04"],
) {
  const r = await createHold(db, {
    propertyId,
    checkIn: d(stay[0]),
    checkOut: d(stay[1]),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
    now: NOW,
  });
  if (!r.ok) throw new Error("expected hold");
  return r.reservationId;
}

/** A confirmed, fully paid (£300) booking. */
async function paidBooking() {
  const property = await createBookableProperty(db);
  const reservationId = await request(property.id);
  const gateway = new FakeGateway();
  // Paid 10 minutes after booking: the 24 hours still run from the booking.
  const paidAt = new Date(NOW.getTime() + 10 * 60_000);
  await startCheckout(db, gateway, {
    reservationId,
    baseUrl: BASE,
    now: paidAt,
  });
  await applyCheckoutSession(db, gateway.pay(gateway.latest().id), paidAt);
  const [charge] = await db
    .select()
    .from(payments)
    .where(eq(payments.reservationId, reservationId));
  return { property, reservationId, gateway, charge };
}

const load = async (id: string) =>
  (await db.select().from(reservations).where(eq(reservations.id, id)))[0];
const templates = async (id: string) =>
  (
    await db
      .select({ t: notificationJobs.template })
      .from(notificationJobs)
      .where(eq(notificationJobs.reservationId, id))
  ).map((r) => r.t);

describe("owner cancellation and refunds", () => {
  it("cancels a paid booking, frees the dates and flags the refund decision without refunding", async () => {
    const { property, reservationId, gateway } = await paidBooking();
    const result = await cancelByOwner(db, {
      propertyId: property.id,
      reservationId,
      actor: OWNER,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, paid: true });
    const r = await load(reservationId);
    expect(r.status).toBe("CANCELLED");
    expect(r.reviewReason).toBe("CANCELLED_REFUND_DECISION");
    expect(gateway.refunds.size).toBe(0);
    expect(await templates(reservationId)).toContain("booking_cancelled");
    // The dates can be booked again.
    expect(await request(property.id)).toBeTruthy();
  });

  it("refunds only what the owner chooses, never more than was paid", async () => {
    const { property, reservationId, gateway, charge } = await paidBooking();
    await cancelByOwner(db, {
      propertyId: property.id,
      reservationId,
      actor: OWNER,
      now: NOW,
    });
    const refund = (amountMinor: number) =>
      issueRefund(db, gateway, {
        propertyId: property.id,
        reservationId,
        chargePaymentId: charge.id,
        amountMinor,
        actor: OWNER,
      });
    expect(await refund(30_001)).toEqual({
      ok: false,
      reason: "INVALID_AMOUNT",
      refundableMinor: 30_000,
    });
    expect(await refund(0)).toMatchObject({
      ok: false,
      reason: "INVALID_AMOUNT",
    });

    expect(await refund(10_000)).toEqual({ ok: true, status: "SUCCEEDED" });
    let r = await load(reservationId);
    // Partly refunded: still cancelled, decision flag stays.
    expect(r.status).toBe("CANCELLED");
    expect(r.reviewReason).toBe("CANCELLED_REFUND_DECISION");
    expect(await refund(20_001)).toMatchObject({ refundableMinor: 20_000 });

    expect(await refund(20_000)).toEqual({ ok: true, status: "SUCCEEDED" });
    r = await load(reservationId);
    expect(r.status).toBe("REFUNDED");
    expect(r.reviewReason).toBeNull();
    expect([...gateway.refunds.values()].map((x) => x.amount)).toEqual([
      10_000, 20_000,
    ]);
  });

  it("tracks a pending refund through Stripe's webhook, idempotently and in order", async () => {
    const { property, reservationId, gateway, charge } = await paidBooking();
    await cancelByOwner(db, {
      propertyId: property.id,
      reservationId,
      actor: OWNER,
      now: NOW,
    });
    gateway.refundStatus = "pending";
    expect(
      await issueRefund(db, gateway, {
        propertyId: property.id,
        reservationId,
        chargePaymentId: charge.id,
        amountMinor: 30_000,
        actor: OWNER,
      }),
    ).toEqual({ ok: true, status: "PROCESSING" });
    expect((await load(reservationId)).status).toBe("REFUND_PENDING");

    const refund = [...gateway.refunds.values()][0];
    const stripe = new Stripe("sk_test_dummy_not_a_real_key");
    const secret = "whsec_test_refund_events";
    const event = (status: string, id = `evt_${randomUUID()}`) => {
      const payload = JSON.stringify({
        id,
        object: "event",
        type: "refund.updated",
        data: {
          object: {
            id: refund.id,
            object: "refund",
            status,
            amount: refund.amount,
            currency: "gbp",
            payment_intent: refund.paymentIntentId,
            metadata: refund.metadata,
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
    const succeeded = event("succeeded");
    expect(await processStripeEvent(db, succeeded, NOW)).toMatchObject({
      outcome: "REFUND_APPLIED",
    });
    expect((await load(reservationId)).status).toBe("REFUNDED");
    // Duplicate delivery and a stale "pending" arriving late change nothing.
    expect(await processStripeEvent(db, succeeded, NOW)).toEqual({
      handled: "duplicate",
    });
    await processStripeEvent(db, event("pending"), NOW);
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.kind, "REFUND"));
    expect(row.status).toBe("SUCCEEDED");
  });

  it("refunds a duplicate payment without touching the confirmed booking", async () => {
    const { property, reservationId, gateway } = await paidBooking();
    // A second payment for the already confirmed booking, flagged by checkout.
    await db.insert(payments).values({
      reservationId,
      kind: "CHARGE",
      purpose: "FULL",
      status: "SUCCEEDED",
      amountMinor: 30_000,
      currency: "GBP",
      idempotencyKey: `dup-${randomUUID()}`,
      stripePaymentIntentId: "pi_test_duplicate",
      failureCode: "DUPLICATE_PAYMENT_REFUND_REQUIRED",
    });
    await db
      .update(reservations)
      .set({ reviewReason: "DUPLICATE_PAYMENT_REFUND_REQUIRED" })
      .where(eq(reservations.id, reservationId));
    const [dup] = await db
      .select()
      .from(payments)
      .where(eq(payments.stripePaymentIntentId, "pi_test_duplicate"));
    expect(
      await issueRefund(db, gateway, {
        propertyId: property.id,
        reservationId,
        chargePaymentId: dup.id,
        amountMinor: 30_000,
        actor: OWNER,
      }),
    ).toEqual({ ok: true, status: "SUCCEEDED" });
    const r = await load(reservationId);
    expect(r.status).toBe("CONFIRMED");
    expect(r.reviewReason).toBeNull();
  });

  it("retries a refund Stripe couldn't take, with the same idempotency key", async () => {
    const { property, reservationId, gateway, charge } = await paidBooking();
    gateway.failRefunds = true;
    expect(
      await issueRefund(db, gateway, {
        propertyId: property.id,
        reservationId,
        chargePaymentId: charge.id,
        amountMinor: 30_000,
        actor: OWNER,
        now: NOW,
      }),
    ).toEqual({ ok: true, status: "PENDING" });
    let [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.kind, "REFUND"));
    expect(row).toMatchObject({ status: "PENDING", providerAttempts: 1 });
    // Not complete, and not retried before its back-off.
    expect((await load(reservationId)).status).not.toBe("REFUNDED");
    expect(await processPendingRefunds(db, gateway, NOW)).toEqual({
      sent: 0,
      skipped: 0,
    });

    gateway.failRefunds = false;
    const later = new Date(NOW.getTime() + HOUR);
    expect(await processPendingRefunds(db, gateway, later)).toEqual({
      sent: 1,
      skipped: 0,
    });
    [row] = await db.select().from(payments).where(eq(payments.id, row.id));
    expect(row.status).toBe("SUCCEEDED");
    expect(gateway.refunds.size).toBe(1);
    // Running again (or a duplicate job) sends nothing more.
    expect(await processPendingRefunds(db, gateway, later)).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(gateway.refunds.size).toBe(1);
  });

  it("gives up after repeated failures, marks the refund failed and alerts the owner", async () => {
    const { property, reservationId, gateway, charge } = await paidBooking();
    gateway.failRefunds = true;
    await issueRefund(db, gateway, {
      propertyId: property.id,
      reservationId,
      chargePaymentId: charge.id,
      amountMinor: 30_000,
      actor: OWNER,
    });
    const [refund] = await db
      .select()
      .from(payments)
      .where(eq(payments.kind, "REFUND"));
    let at = NOW;
    for (let i = 1; i < REFUND_MAX_ATTEMPTS; i++) {
      at = new Date(at.getTime() + 2 * HOUR);
      await sendRefund(db, gateway, refund.id, at);
    }
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, refund.id));
    expect(row).toMatchObject({
      status: "FAILED",
      providerAttempts: REFUND_MAX_ATTEMPTS,
    });
    expect((await load(reservationId)).reviewReason).toBe("REFUND_FAILED");
    expect(await templates(reservationId)).toContain("owner_refund_failed");
    // A failed refund doesn't count: the amount can be refunded again.
    gateway.failRefunds = false;
    expect(
      await issueRefund(db, gateway, {
        propertyId: property.id,
        reservationId,
        chargePaymentId: charge.id,
        amountMinor: 30_000,
        actor: OWNER,
      }),
    ).toEqual({ ok: true, status: "SUCCEEDED" });
  });

  it("can't refund an unpaid or someone else's charge", async () => {
    const { property, charge } = await paidBooking();
    const otherProperty = await createBookableProperty(db);
    const other = await request(otherProperty.id);
    expect(
      await issueRefund(db, new FakeGateway(), {
        propertyId: otherProperty.id,
        reservationId: other,
        chargePaymentId: charge.id,
        amountMinor: 100,
        actor: OWNER,
      }),
    ).toEqual({ ok: false, reason: "NOT_REFUNDABLE" });
    void property;
  });
});

describe("resolving flagged bookings", () => {
  it("confirms a late but full payment once the owner reviews it", async () => {
    const property = await createBookableProperty(db);
    const reservationId = await request(property.id);
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await expireLapsedHolds(db, null, new Date(NOW.getTime() + LAPSED));
    await applyCheckoutSession(db, gateway.pay(gateway.latest().id), NOW);
    expect((await load(reservationId)).status).toBe("REQUIRES_REVIEW");

    expect(
      await confirmReviewedBooking(db, {
        propertyId: property.id,
        reservationId,
        actor: OWNER,
        now: NOW,
      }),
    ).toEqual({ ok: true });
    const r = await load(reservationId);
    expect([r.status, r.reviewReason]).toEqual(["CONFIRMED", null]);
    expect(await templates(reservationId)).toContain("booking_confirmed");
  });

  it("never confirms a booking under review that hasn't been paid in full", async () => {
    const property = await createBookableProperty(db);
    const reservationId = await request(property.id);
    await db
      .update(reservations)
      .set({ status: "REQUIRES_REVIEW", reviewReason: "CALENDAR_CONFLICT" })
      .where(eq(reservations.id, reservationId));
    expect(
      await confirmReviewedBooking(db, {
        propertyId: property.id,
        reservationId,
        actor: OWNER,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "NOT_PAID_IN_FULL" });
    expect(
      await markFlagResolved(db, {
        propertyId: property.id,
        reservationId,
        actor: OWNER,
        note: "x",
      }),
    ).toEqual({ ok: false, reason: "NOT_ALLOWED" });
  });

  it("lets the owner clear a refund flag handled elsewhere, with a note", async () => {
    const { property, reservationId } = await paidBooking();
    await db
      .update(reservations)
      .set({ reviewReason: "DUPLICATE_PAYMENT_REFUND_REQUIRED" })
      .where(eq(reservations.id, reservationId));
    expect(
      await markFlagResolved(db, {
        propertyId: property.id,
        reservationId,
        actor: OWNER,
        note: "Refunded in the Stripe dashboard",
      }),
    ).toEqual({ ok: true });
    expect((await load(reservationId)).reviewReason).toBeNull();
  });
});

describe("guest cancellation under the 24-hour policy", () => {
  const cancel = (
    propertyId: string,
    reservationId: string,
    receivedAt: Date,
    acknowledgeNoRefund = false,
  ) =>
    guestCancel(db, {
      propertyId,
      reservationId,
      receivedAt,
      acknowledgeNoRefund,
    });
  const refundRows = (reservationId: string) =>
    db
      .select()
      .from(payments)
      .where(eq(payments.reservationId, reservationId))
      .then((rows) => rows.filter((p) => p.kind === "REFUND"));

  it("releases an unpaid hold at once", async () => {
    const property = await createBookableProperty(db);
    const reservationId = await request(property.id);
    expect(await cancel(property.id, reservationId, NOW)).toMatchObject({
      ok: true,
      outcome: "HOLD_RELEASED",
    });
    const r = await load(reservationId);
    expect([r.status, r.cancelledBy]).toEqual(["CANCELLED", "GUEST"]);
    expect(await refundRows(reservationId)).toHaveLength(0);
    // The dates are bookable again.
    expect(await request(property.id)).toBeTruthy();
  });

  it("refunds in full 1 ms before the deadline, and only once Stripe confirms is it refunded", async () => {
    const { property, reservationId, gateway } = await paidBooking();
    gateway.refundStatus = "pending";
    const justBefore = new Date(DEADLINE.getTime() - 1);
    const result = await cancel(property.id, reservationId, justBefore);
    expect(result).toMatchObject({
      ok: true,
      outcome: "CANCELLED_WITH_REFUND",
      refundMinor: 30_000,
    });
    if (!result.ok || result.outcome !== "CANCELLED_WITH_REFUND") return;
    // Queued in the same transaction as the cancellation.
    expect(
      (await refundRows(reservationId)).map((p) => [
        p.status,
        p.amountMinor,
        p.initiatedBy,
      ]),
    ).toEqual([["PENDING", 30_000, "GUEST_POLICY"]]);
    expect((await load(reservationId)).status).toBe("REFUND_PENDING");

    expect(await sendRefund(db, gateway, result.refundIds[0], justBefore)).toBe(
      "PROCESSING",
    );
    // Sent, but Stripe hasn't confirmed: still not "refunded".
    expect((await load(reservationId)).status).toBe("REFUND_PENDING");
    expect(await templates(reservationId)).not.toContain("refund_completed");

    const [stripeRefund] = [...gateway.refunds.values()];
    stripeRefund.status = "succeeded";
    const { applyRefundSnapshot } = await import("./refunds");
    await applyRefundSnapshot(db, stripeRefund);
    const r = await load(reservationId);
    expect([r.status, r.cancelledBy]).toEqual(["REFUNDED", "GUEST"]);
    expect(await templates(reservationId)).toEqual(
      expect.arrayContaining([
        "guest_cancellation_confirmed",
        "owner_guest_cancelled",
        "refund_completed",
      ]),
    );

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "reservation.cancelled_by_guest"));
    expect(entry.metadata).toMatchObject({
      receivedAt: justBefore.toISOString(),
      freeCancellationUntil: DEADLINE.toISOString(),
      refundEligible: true,
      refundMinor: 30_000,
    });
  });

  for (const [label, at] of [
    ["exactly at", DEADLINE],
    ["1 ms after", new Date(DEADLINE.getTime() + 1)],
  ] as const)
    it(`is non-refundable ${label} the deadline, and needs the guest's acknowledgement`, async () => {
      const { property, reservationId, gateway } = await paidBooking();
      expect(await cancel(property.id, reservationId, at)).toEqual({
        ok: false,
        reason: "ACK_REQUIRED",
      });
      expect((await load(reservationId)).status).toBe("CONFIRMED");

      expect(await cancel(property.id, reservationId, at, true)).toEqual({
        ok: true,
        outcome: "CANCELLED_NO_REFUND",
      });
      const r = await load(reservationId);
      expect([r.status, r.reviewReason]).toEqual(["CANCELLED", null]);
      expect(await refundRows(reservationId)).toHaveLength(0);
      expect(gateway.refunds.size).toBe(0);
      expect(await templates(reservationId)).toEqual(
        expect.arrayContaining([
          "guest_cancellation_confirmed",
          "owner_guest_cancelled",
        ]),
      );
    });

  it("counts the 24 hours from the booking, not from the payment", async () => {
    // paidBooking pays 10 minutes after booking; 24 h after payment is late.
    const { property, reservationId } = await paidBooking();
    const dayAfterPayment = new Date(NOW.getTime() + 24 * HOUR + 5 * 60_000);
    expect(await cancel(property.id, reservationId, dayAfterPayment)).toEqual({
      ok: false,
      reason: "ACK_REQUIRED",
    });
  });

  it("can't cancel twice or refund twice, even concurrently", async () => {
    const { property, reservationId } = await paidBooking();
    const at = new Date(NOW.getTime() + HOUR);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => cancel(property.id, reservationId, at)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.reason === "NOT_ALLOWED"),
    ).toHaveLength(3);
    expect(await refundRows(reservationId)).toHaveLength(1);
  });

  it("waits while a payment is still settling", async () => {
    const { property, reservationId } = await paidBooking();
    await db.insert(payments).values({
      reservationId,
      kind: "CHARGE",
      purpose: "FULL",
      status: "PROCESSING",
      amountMinor: 100,
      currency: "GBP",
      idempotencyKey: `processing-${randomUUID()}`,
    });
    expect(await cancel(property.id, reservationId, NOW)).toEqual({
      ok: false,
      reason: "PAYMENT_PROCESSING",
    });
  });

  it("leaves owner cancellations to the owner's refund decision", async () => {
    const { property, reservationId, gateway } = await paidBooking();
    await cancelByOwner(db, {
      propertyId: property.id,
      reservationId,
      actor: OWNER,
      now: NOW,
    });
    const r = await load(reservationId);
    expect(r.cancelledBy).toBe(`OWNER:${OWNER}`);
    expect(await refundRows(reservationId)).toHaveLength(0);
    expect(gateway.refunds.size).toBe(0);
    expect(await cancel(property.id, reservationId, NOW)).toEqual({
      ok: false,
      reason: "NOT_ALLOWED",
    });
  });
});
