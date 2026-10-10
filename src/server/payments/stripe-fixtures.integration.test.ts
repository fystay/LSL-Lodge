import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import { payments, reservations } from "@/server/db/schema";
import { createHold } from "@/server/booking/holds";
import { guestCancel } from "@/server/booking/resolution";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { startCheckout } from "./checkout";
import { sendRefund } from "./refunds";
import { verifyStripeWebhook } from "./stripe-webhook";
import { processStripeEvent } from "./webhook";

/**
 * Real payloads captured from a Stripe test-mode sandbox
 * (tests/fixtures/stripe/), run through the real webhook path. Only the IDs
 * are rewritten to rows in the test database; every other field is exactly
 * as Stripe sent it. Signed locally with a test secret. No network calls.
 */
const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/stripe/${name}.json`, "utf8")) as {
    data: { object: Record<string, unknown> & { metadata: object } };
  };
const stripe = new Stripe("sk_test_dummy_not_a_real_key");
const secret = "whsec_test_secret_for_fixture_tests";
const signed = (event: object) => {
  const payload = JSON.stringify(event);
  return verifyStripeWebhook(
    stripe,
    payload,
    stripe.webhooks.generateTestHeaderString({ payload, secret }),
    secret,
  );
};
const NOW = new Date("2026-10-08T12:00:00Z");

describe("real Stripe sandbox payloads", () => {
  it("confirm a booking from checkout.session.completed and finish a refund from refund.updated", async () => {
    const property = await createBookableProperty(db);
    const hold = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-01"),
      checkOut: d("2027-03-04"),
      guests: 2,
      guest: { name: "Sandbox Guest", email: "sandbox-guest@example.test" },
      idempotencyKey: randomUUID(),
      now: NOW,
    });
    if (!hold.ok) throw new Error("expected hold");
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId: hold.reservationId,
      baseUrl: "http://localhost:3000",
      now: NOW,
    });
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.reservationId, hold.reservationId));

    const completed = fixture("checkout.session.completed");
    Object.assign(completed.data.object, {
      id: payment.stripeCheckoutSessionId,
      client_reference_id: hold.reservationId,
      amount_total: payment.amountMinor,
      amount_subtotal: payment.amountMinor,
    });
    completed.data.object.metadata = {
      ...completed.data.object.metadata,
      reservation_id: hold.reservationId,
      payment_id: payment.id,
    };
    const verifiedAt = new Date(NOW.getTime() + 5 * 60_000);
    expect(await processStripeEvent(db, signed(completed), verifiedAt)).toEqual(
      {
        handled: "applied",
        type: "checkout.session.completed",
        outcome: "CONFIRMED",
      },
    );
    const [charge] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id));
    expect([charge.status, charge.stripePaymentIntentId]).toEqual([
      "SUCCEEDED",
      "pi_3UOuvzCyjWPP8AoI0EaSx7jN",
    ]);
    const [confirmed] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId));
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt?.toISOString()).toBe(verifiedAt.toISOString());

    // Guest cancels within 24 hours; Stripe first says "pending".
    gateway.refundStatus = "pending";
    const cancelled = await guestCancel(db, {
      propertyId: property.id,
      reservationId: hold.reservationId,
      receivedAt: new Date(verifiedAt.getTime() + 60 * 60_000),
    });
    if (!cancelled.ok || cancelled.outcome !== "CANCELLED_WITH_REFUND")
      throw new Error("expected refund");
    await sendRefund(db, gateway, cancelled.refundIds[0]);
    const [sent] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, cancelled.refundIds[0]));
    expect(sent.status).toBe("PROCESSING");

    const updated = fixture("refund.updated");
    Object.assign(updated.data.object, { id: sent.stripeRefundId });
    updated.data.object.metadata = {
      refund_payment_id: sent.id,
      reservation_id: hold.reservationId,
    };
    expect(await processStripeEvent(db, signed(updated), NOW)).toMatchObject({
      handled: "applied",
      outcome: "REFUND_APPLIED",
    });
    const [refunded] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId));
    expect(refunded.status).toBe("REFUNDED");
  });
});
