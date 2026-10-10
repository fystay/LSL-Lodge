import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  verifyStripeWebhook,
  WebhookVerificationError,
} from "./stripe-webhook";

// Offline: no network calls are made. The key is a syntactically valid dummy.
const stripe = new Stripe("sk_test_dummy_not_a_real_key");
const secret = "whsec_test_secret_for_unit_tests";
const payload = JSON.stringify({
  id: "evt_test_123",
  object: "event",
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_123", object: "checkout.session" } },
});

const sign = (
  body: string,
  options: { secret?: string; timestamp?: number } = {},
) =>
  stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: options.secret ?? secret,
    timestamp: options.timestamp,
  });

describe("verifyStripeWebhook", () => {
  it("accepts a correctly signed raw body", () => {
    const event = verifyStripeWebhook(stripe, payload, sign(payload), secret);
    expect(event.id).toBe("evt_test_123");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a missing signature header", () => {
    expect(() => verifyStripeWebhook(stripe, payload, null, secret)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a body altered after signing", () => {
    const header = sign(payload);
    const tampered = payload.replace("cs_test_123", "cs_test_999");
    expect(() => verifyStripeWebhook(stripe, tampered, header, secret)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects re-serialised JSON (must use the raw body)", () => {
    const header = sign(payload);
    const reserialised = JSON.stringify(JSON.parse(payload), null, 2);
    expect(() =>
      verifyStripeWebhook(stripe, reserialised, header, secret),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a signature made with a different secret", () => {
    const header = sign(payload, { secret: "whsec_someone_else" });
    expect(() => verifyStripeWebhook(stripe, payload, header, secret)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a replayed event outside the timestamp tolerance", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const header = sign(payload, { timestamp: oneHourAgo });
    expect(() => verifyStripeWebhook(stripe, payload, header, secret)).toThrow(
      WebhookVerificationError,
    );
  });
});

describe("checkoutSessionParams", () => {
  it("charges in the booking currency only, with the policy message and expiry", async () => {
    const { checkoutSessionParams } = await import("./gateway");
    const params = checkoutSessionParams({
      reservationId: "r1",
      paymentId: "p1",
      publicRef: "LL-ABC234",
      amountMinor: 51_000,
      currency: "GBP",
      description: "Lodge on the Lake: 2027-03-01 to 2027-03-04 (LL-ABC234)",
      customerEmail: "guest@example.test",
      successUrl: "https://example.test/ok?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://example.test/book/LL-ABC234/checkout-cancelled?p=p1",
      expiresAt: new Date("2026-10-10T12:31:00Z"),
      submitMessage:
        "The 24-hour free-cancellation period starts once your payment is confirmed.",
      idempotencyKey: "checkout:r1:i1:1",
    });
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params.line_items?.[0].price_data).toMatchObject({
      currency: "gbp",
      unit_amount: 51_000,
    });
    expect(params.expires_at).toBe(Date.parse("2026-10-10T12:31:00Z") / 1000);
    expect((params.custom_text?.submit as { message: string }).message).toMatch(
      /starts once your payment/,
    );
    expect(params.metadata).toEqual({
      reservation_id: "r1",
      payment_id: "p1",
      public_ref: "LL-ABC234",
    });
  });
});
