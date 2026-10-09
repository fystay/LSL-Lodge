import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import { notificationJobs, payments, reservations } from "@/server/db/schema";
import { createHold, expireLapsedHolds } from "@/server/booking/holds";
import { approveRequest } from "@/server/booking/requests";
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
import { issueRefund } from "./refunds";
import { verifyStripeWebhook } from "./stripe-webhook";
import { processStripeEvent } from "./webhook";

const db = testDatabase(20);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Synthetic data only; the gateway is in memory.
const NOW = new Date("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
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
  if (!r.ok) throw new Error("expected request");
  return r.reservationId;
}

/** A confirmed, fully paid (£300) booking. */
async function paidBooking() {
  const property = await createBookableProperty(db);
  const reservationId = await request(property.id);
  await approveRequest(db, {
    propertyId: property.id,
    reservationId,
    actor: OWNER,
    now: NOW,
  });
  const gateway = new FakeGateway();
  await startCheckout(db, gateway, { reservationId, baseUrl: BASE, now: NOW });
  await applyCheckoutSession(db, gateway.pay(gateway.latest().id), NOW);
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

  it("records a refund Stripe refused, so the amount can be refunded again", async () => {
    const { property, reservationId, gateway, charge } = await paidBooking();
    gateway.failRefunds = true;
    const args = {
      propertyId: property.id,
      reservationId,
      chargePaymentId: charge.id,
      amountMinor: 30_000,
      actor: OWNER,
    };
    expect(await issueRefund(db, gateway, args)).toEqual({
      ok: false,
      reason: "PROVIDER_ERROR",
    });
    gateway.failRefunds = false;
    expect(await issueRefund(db, gateway, args)).toEqual({
      ok: true,
      status: "SUCCEEDED",
    });
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
    await approveRequest(db, {
      propertyId: property.id,
      reservationId,
      actor: OWNER,
      now: NOW,
    });
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await expireLapsedHolds(db, null, new Date(NOW.getTime() + 25 * HOUR));
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

describe("guest cancellation", () => {
  it("withdraws an unpaid request at once and tells the owner", async () => {
    const property = await createBookableProperty(db);
    const reservationId = await request(property.id);
    expect(
      await guestCancel(db, {
        propertyId: property.id,
        reservationId,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      outcome: "WITHDRAWN",
    });
    expect((await load(reservationId)).status).toBe("CANCELLED");
    expect(await templates(reservationId)).toContain("owner_booking_withdrawn");
  });

  it("only records a request to cancel a paid booking, once", async () => {
    const { property, reservationId } = await paidBooking();
    for (let i = 0; i < 2; i++)
      expect(
        await guestCancel(db, {
          propertyId: property.id,
          reservationId,
          now: NOW,
        }),
      ).toEqual({
        ok: true,
        outcome: "REQUESTED",
      });
    const r = await load(reservationId);
    expect(r.status).toBe("CONFIRMED");
    expect(r.cancellationRequestedAt).not.toBeNull();
    expect(
      (await templates(reservationId)).filter(
        (t) => t === "owner_cancellation_requested",
      ),
    ).toHaveLength(1);
  });
});
