import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import { auditLogs, payments, reservations } from "@/server/db/schema";
import { createHold } from "@/server/booking/holds";
import { guestCancel } from "@/server/booking/resolution";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { applyCheckoutSession, startCheckout } from "./checkout";
import { reconcilePayments } from "./reconcile";
import { sendRefund } from "./refunds";

const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Rows get real-clock creation times, so "later" is relative to now.
const MINUTE = 60_000;
const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

async function checkoutStarted() {
  const property = await createBookableProperty(db);
  const hold = await createHold(db, {
    propertyId: property.id,
    checkIn: d("2027-05-03"),
    checkOut: d("2027-05-06"),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
  });
  if (!hold.ok) throw new Error("expected hold");
  const gateway = new FakeGateway();
  await startCheckout(db, gateway, {
    reservationId: hold.reservationId,
    baseUrl: "http://localhost:3000",
  });
  return { property, reservationId: hold.reservationId, gateway };
}

const load = async (id: string) =>
  (await db.select().from(reservations).where(eq(reservations.id, id)))[0];
const reconciledAudits = async (id: string) =>
  db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.targetId, id),
        eq(auditLogs.action, "payment.reconciled"),
      ),
    );

describe("Stripe reconciliation", () => {
  it("confirms a paid booking whose webhook never arrived, once", async () => {
    const { reservationId, gateway } = await checkoutStarted();
    gateway.pay(gateway.latest().id); // paid at Stripe; no webhook
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");

    const result = await reconcilePayments(db, gateway, later(15));
    expect(result).toMatchObject({ charges: 1, chargesChanged: 1, errors: 0 });
    const r = await load(reservationId);
    expect(r.status).toBe("CONFIRMED");
    expect(r.confirmedAt).not.toBeNull();
    expect(await reconciledAudits(reservationId)).toHaveLength(1);

    // Nothing left to do; the late webhook is then a no-op too.
    expect(await reconcilePayments(db, gateway, later(30))).toMatchObject({
      charges: 0,
    });
    expect(await applyCheckoutSession(db, gateway.latest(), later(31))).toBe(
      "ALREADY_APPLIED",
    );
  });

  it("leaves recent payments to the webhook", async () => {
    const { reservationId, gateway } = await checkoutStarted();
    gateway.pay(gateway.latest().id);
    // Under 10 minutes old: not reconciled yet.
    expect(await reconcilePayments(db, gateway, later(5))).toMatchObject({
      charges: 0,
    });
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");
  });

  it("leaves a session the guest is still paying on alone", async () => {
    const { reservationId, gateway } = await checkoutStarted();
    expect(await reconcilePayments(db, gateway, later(15))).toMatchObject({
      charges: 1,
      chargesChanged: 0,
    });
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");
  });

  it("counts a Stripe error and carries on", async () => {
    const { reservationId } = await checkoutStarted();
    // A gateway that doesn't know the session (e.g. Stripe unreachable).
    const result = await reconcilePayments(db, new FakeGateway(), later(15));
    expect(result).toMatchObject({ charges: 1, errors: 1 });
    expect((await load(reservationId)).status).toBe("PENDING_PAYMENT");
  });

  it("does nothing without Stripe configured", async () => {
    await checkoutStarted();
    expect(await reconcilePayments(db, null, later(15))).toEqual({
      charges: 0,
      chargesChanged: 0,
      refunds: 0,
      refundsChanged: 0,
      errors: 0,
    });
  });

  it("settles a refund whose webhook never arrived", async () => {
    const { property, reservationId, gateway } = await checkoutStarted();
    await applyCheckoutSession(db, gateway.pay(gateway.latest().id));
    gateway.refundStatus = "pending";
    const result = await guestCancel(db, {
      propertyId: property.id,
      reservationId,
      receivedAt: new Date(),
    });
    if (!result.ok || result.outcome !== "CANCELLED_WITH_REFUND")
      throw new Error("expected a policy refund");
    expect(await sendRefund(db, gateway, result.refundIds[0])).toBe(
      "PROCESSING",
    );
    // Stripe completes it, but the refund.updated webhook is lost.
    [...gateway.refunds.values()][0].status = "succeeded";

    expect(await reconcilePayments(db, gateway, later(15))).toMatchObject({
      refunds: 1,
      refundsChanged: 1,
    });
    const [refund] = await db
      .select()
      .from(payments)
      .where(eq(payments.kind, "REFUND"));
    expect(refund.status).toBe("SUCCEEDED");
    expect((await load(reservationId)).status).toBe("REFUNDED");
  });
});
