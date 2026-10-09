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
import { approveRequest, declineRequest } from "@/server/booking/requests";
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
const OWNER = "owner@example.test";
const BASE = "http://localhost:3000";

async function approvedRequest(
  overrides: Parameters<typeof createBookableProperty>[1] = {},
  stay: [string, string] = ["2027-03-01", "2027-03-04"],
) {
  const property = await createBookableProperty(db, overrides);
  const req = await createHold(db, {
    propertyId: property.id,
    checkIn: d(stay[0]),
    checkOut: d(stay[1]),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
    now: NOW,
  });
  if (!req.ok) throw new Error("expected request");
  const approved = await approveRequest(db, {
    propertyId: property.id,
    reservationId: req.reservationId,
    actor: OWNER,
    now: NOW,
  });
  if (!approved.ok) throw new Error("expected approval");
  return { property, reservationId: req.reservationId };
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
    const { reservationId } = await approvedRequest();
    const gateway = new FakeGateway();
    const at = new Date(NOW.getTime() + HOUR);
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
    const { reservationId } = await approvedRequest();
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

  it("never charges before approval, after decline or after the deadline", async () => {
    const property = await createBookableProperty(db);
    const gateway = new FakeGateway();
    const req = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-01"),
      checkOut: d("2027-03-04"),
      guests: 2,
      guest: { name: "Test Guest", email: "guest@example.test" },
      idempotencyKey: randomUUID(),
      now: NOW,
    });
    if (!req.ok) throw new Error("expected request");
    const start = (now = NOW) =>
      startCheckout(db, gateway, {
        reservationId: req.reservationId,
        baseUrl: BASE,
        now,
      });
    expect(await start()).toEqual({ ok: false, reason: "NOT_PAYABLE" });
    await declineRequest(db, {
      propertyId: property.id,
      reservationId: req.reservationId,
      actor: OWNER,
      now: NOW,
    });
    expect(await start()).toEqual({ ok: false, reason: "NOT_PAYABLE" });

    const { reservationId } = await approvedRequest({}, [
      "2027-05-01",
      "2027-05-04",
    ]);
    expect(
      await startCheckout(db, gateway, {
        reservationId,
        baseUrl: BASE,
        now: new Date(NOW.getTime() + 25 * HOUR),
      }),
    ).toEqual({ ok: false, reason: "EXPIRED" });
    expect(gateway.created).toHaveLength(0);
  });

  it("extends the hold to cover a session started near the deadline", async () => {
    const { reservationId } = await approvedRequest({ paymentWindowHours: 1 });
    const gateway = new FakeGateway();
    const at = new Date(NOW.getTime() + 50 * MIN); // 10 minutes left
    await startCheckout(db, gateway, { reservationId, baseUrl: BASE, now: at });
    const session = gateway.latest();
    expect(session.expiresAt.getTime() - at.getTime()).toBe(31 * MIN);
    expect((await load(reservationId)).holdExpiresAt).toEqual(
      session.expiresAt,
    );
  });

  it("refuses payment if another calendar now overlaps the stay", async () => {
    const { property, reservationId } = await approvedRequest();
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
  it("confirms an approved request only on verified full payment", async () => {
    const { reservationId } = await approvedRequest();
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
    expect((await load(reservationId)).status).toBe("APPROVED");

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
    const { reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
    const other = await approvedRequest({}, ["2027-06-01", "2027-06-04"]);
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
    expect((await load(reservationId)).status).toBe("APPROVED");
    expect((await load(other.reservationId)).status).toBe("APPROVED");
  });

  it("routes a payment that lands after expiry to review if the dates are still free", async () => {
    const { reservationId } = await approvedRequest();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    await expireLapsedHolds(db, null, new Date(NOW.getTime() + 25 * HOUR));
    expect((await load(reservationId)).status).toBe("EXPIRED");

    const paid = gateway.pay(gateway.latest().id);
    expect(await applyCheckoutSession(db, paid, NOW)).toBe("NEEDS_REVIEW");
    const r = await load(reservationId);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect(r.reviewReason).toBe("PAYMENT_AFTER_EXPIRY");
    expect((await paymentRows(reservationId))[0].status).toBe("SUCCEEDED");
  });

  it("flags a refund when a late payment's dates were re-booked", async () => {
    const { property, reservationId } = await approvedRequest();
    const gateway = new FakeGateway();
    await startCheckout(db, gateway, {
      reservationId,
      baseUrl: BASE,
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 25 * HOUR);
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
    // The money is recorded, never lost.
    expect((await paymentRows(reservationId))[0].status).toBe("SUCCEEDED");
  });

  it("does not confirm if an imported calendar overlaps by the time payment lands", async () => {
    const { property, reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
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
    expect(rows.filter((p) => p.status === "SUCCEEDED")).toHaveLength(2);
    expect(
      rows.find((p) => p.stripeCheckoutSessionId === second.id)?.failureCode,
    ).toBe("DUPLICATE_PAYMENT_REFUND_REQUIRED");
  });

  it("still applies a paid session whose ID wasn't saved", async () => {
    const { reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
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

  it("marks an expired session's payment cancelled and keeps the request approved", async () => {
    const { reservationId } = await approvedRequest();
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
    expect((await load(reservationId)).status).toBe("APPROVED");

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
    const { reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
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
    const { reservationId } = await approvedRequest();
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
    expect((await load(reservationId)).status).toBe("APPROVED");
  });

  it("ignores unrelated event types but records them", async () => {
    const { reservationId } = await approvedRequest();
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
