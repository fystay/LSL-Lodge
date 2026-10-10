/**
 * The Stripe webhook contract, shared by the webhook handler, the test-mode
 * webhook setup script and the staging preflight. No `server-only` import:
 * the scripts run outside Next.js. Contains no secrets.
 */

/** Refunds issued from admin report progress through these. */
export const STRIPE_REFUND_EVENTS = [
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;

export const STRIPE_CHECKOUT_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
] as const;

/** Every event the webhook endpoint must be subscribed to. */
export const STRIPE_WEBHOOK_EVENTS = [
  ...STRIPE_CHECKOUT_EVENTS,
  ...STRIPE_REFUND_EVENTS,
] as const;

/** The API version the app's Stripe SDK (stripe@23) is built for. */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
