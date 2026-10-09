import "server-only";
import Stripe from "stripe";
import { assertStripeTestModeUnlessApproved, stripeEnv } from "@/server/env";

/**
 * The slice of Stripe Checkout the booking domain uses, behind an interface
 * so the domain can be tested without the network and the provider stays
 * swappable. Stripe-hosted Checkout keeps card data off our servers entirely.
 */

export interface CheckoutSessionSnapshot {
  id: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  clientReferenceId: string | null;
  paymentIntentId: string | null;
  url: string | null;
  metadata: Record<string, string>;
  expiresAt: Date;
}

export interface CreateCheckoutParams {
  reservationId: string;
  paymentId: string;
  publicRef: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  /** Stable per payment attempt: a retried request returns the same session. */
  idempotencyKey: string;
}

export interface PaymentGateway {
  createCheckoutSession(
    params: CreateCheckoutParams,
  ): Promise<CheckoutSessionSnapshot>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot>;
  /** Stops an open session accepting payment. No-op if it already ended. */
  expireCheckoutSession(id: string): Promise<void>;
}

export function snapshotFromStripe(
  session: Stripe.Checkout.Session,
): CheckoutSessionSnapshot {
  const intent = session.payment_intent;
  return {
    id: session.id,
    status: (session.status ?? "open") as CheckoutSessionSnapshot["status"],
    // Unknown future values are treated as unpaid, never as paid.
    paymentStatus: (["paid", "no_payment_required"].includes(
      session.payment_status,
    )
      ? session.payment_status
      : "unpaid") as CheckoutSessionSnapshot["paymentStatus"],
    amountTotal: session.amount_total,
    currency: session.currency,
    clientReferenceId: session.client_reference_id,
    paymentIntentId: typeof intent === "string" ? intent : (intent?.id ?? null),
    url: session.url,
    metadata: (session.metadata ?? {}) as Record<string, string>,
    expiresAt: new Date(session.expires_at * 1000),
  };
}

class StripeCheckoutGateway implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async createCheckoutSession(p: CreateCheckoutParams) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        // Card (including wallets) settles synchronously, so a payment can't
        // still be pending when the dates' hold runs out.
        allowed_payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: p.currency.toLowerCase(),
              unit_amount: p.amountMinor,
              product_data: { name: p.description },
            },
          },
        ],
        customer_email: p.customerEmail,
        client_reference_id: p.reservationId,
        metadata: {
          reservation_id: p.reservationId,
          payment_id: p.paymentId,
          public_ref: p.publicRef,
        },
        payment_intent_data: {
          metadata: {
            reservation_id: p.reservationId,
            payment_id: p.paymentId,
          },
        },
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        expires_at: Math.floor(p.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: p.idempotencyKey },
    );
    return snapshotFromStripe(session);
  }

  async retrieveCheckoutSession(id: string) {
    return snapshotFromStripe(await this.stripe.checkout.sessions.retrieve(id));
  }

  async expireCheckoutSession(id: string) {
    const session = await this.stripe.checkout.sessions.retrieve(id);
    if (session.status === "open")
      await this.stripe.checkout.sessions.expire(id);
  }
}

let cachedStripe: Stripe | undefined;

/** Server-only Stripe client. Refuses live keys unless live mode was approved. */
export function getStripe(): Stripe {
  if (cachedStripe) return cachedStripe;
  const { STRIPE_SECRET_KEY } = stripeEnv();
  assertStripeTestModeUnlessApproved(STRIPE_SECRET_KEY);
  cachedStripe = new Stripe(STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "lodge-on-the-lake" },
  });
  return cachedStripe;
}

export function paymentsConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET,
  );
}

/** The configured gateway, or null when Stripe isn't set up (payment step unavailable). */
export function getPaymentGateway(): PaymentGateway | null {
  if (!paymentsConfigured()) return null;
  return new StripeCheckoutGateway(getStripe());
}
