import "server-only";
import Stripe from "stripe";

/**
 * Stripe webhook signature verification (Phase 0 prototype; event processing
 * lands in Phase 3).
 *
 * Must be given the *raw* request body exactly as received. Re-serialised
 * JSON will not verify. A verified signature proves the event came from
 * Stripe; it does not by itself prove a booking is paid. Processing must
 * still record the event ID idempotently and re-check amount, currency,
 * reservation reference and reservation state (see docs/PAYMENTS.md).
 */

export class WebhookVerificationError extends Error {
  constructor() {
    super("Webhook signature verification failed");
    this.name = "WebhookVerificationError";
  }
}

/** Stripe's default tolerance for the signed timestamp, in seconds. */
const TOLERANCE_SECONDS = 300;

export function verifyStripeWebhook(
  stripe: Stripe,
  rawBody: string | Buffer,
  signatureHeader: string | null,
  endpointSecret: string,
): Stripe.Event {
  if (!signatureHeader) throw new WebhookVerificationError();
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      endpointSecret,
      TOLERANCE_SECONDS,
    );
  } catch {
    throw new WebhookVerificationError();
  }
}
