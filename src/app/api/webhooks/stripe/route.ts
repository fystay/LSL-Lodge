import { db, isDatabaseConfigured } from "@/server/db/client";
import { stripeEnv } from "@/server/env";
import {
  getPaymentGateway,
  getStripe,
  paymentsConfigured,
} from "@/server/payments/gateway";
import { processPendingRefunds } from "@/server/payments/refunds";
import { processStripeEvent } from "@/server/payments/webhook";
import {
  verifyStripeWebhook,
  WebhookVerificationError,
} from "@/server/payments/stripe-webhook";

/**
 * Stripe webhook endpoint. The signature is verified against the raw body
 * before anything else; processing is idempotent per event ID. Responses
 * carry no detail an attacker could use.
 *
 * - 400: bad signature. A forged request learns nothing and changes nothing.
 * - 500: processing failed and was recorded; Stripe retries with backoff.
 * - 503: payments aren't configured on this deployment.
 */
export async function POST(request: Request) {
  if (!paymentsConfigured() || !isDatabaseConfigured())
    return Response.json({ error: "not_configured" }, { status: 503 });

  const rawBody = await request.text();
  let event;
  try {
    event = verifyStripeWebhook(
      getStripe(),
      rawBody,
      request.headers.get("stripe-signature"),
      stripeEnv().STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    throw error;
  }

  try {
    const outcome = await processStripeEvent(db(), event);
    console.info("stripe.webhook", {
      eventId: event.id,
      type: event.type,
      handled: outcome.handled,
      outcome: "outcome" in outcome ? outcome.outcome : undefined,
    });
    // A payment that isn't owed (duplicate, or for a cancelled booking) is
    // queued for refund while processing; send it now rather than waiting
    // for the job. Best effort: the process-refunds job retries anything left.
    if ("outcome" in outcome && outcome.outcome === "REFUND_REQUIRED")
      await processPendingRefunds(db(), getPaymentGateway()).catch(() => {
        console.error("stripe.webhook_refund_send_failed", {
          eventId: event.id,
        });
      });
    return Response.json({ received: true });
  } catch {
    console.error("stripe.webhook_failed", {
      eventId: event.id,
      type: event.type,
    });
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}
