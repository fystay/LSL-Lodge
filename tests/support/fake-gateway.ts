import { randomUUID } from "node:crypto";
import type {
  CheckoutSessionSnapshot,
  CreateCheckoutParams,
  PaymentGateway,
  RefundSnapshot,
  RefundStatus,
} from "@/server/payments/gateway";

/**
 * In-memory stand-in for Stripe Checkout, for tests only. It mirrors the
 * fields the booking domain reads; it never talks to Stripe.
 */
export class FakeGateway implements PaymentGateway {
  readonly sessions = new Map<string, CheckoutSessionSnapshot>();
  readonly created: CreateCheckoutParams[] = [];
  readonly expired: string[] = [];
  private byIdempotencyKey = new Map<string, string>();
  readonly refunds = new Map<string, RefundSnapshot>();
  /** Status new refunds get (cards usually succeed at once). */
  refundStatus: RefundStatus = "succeeded";
  failRefunds = false;

  async createRefund(p: {
    paymentIntentId: string;
    amountMinor: number;
    refundPaymentId: string;
    reservationId: string;
    idempotencyKey: string;
  }) {
    if (this.failRefunds) throw new Error("Stripe unavailable");
    const existing = [...this.refunds.values()].find(
      (r) => r.metadata.idempotency_key === p.idempotencyKey,
    );
    if (existing) return existing;
    const refund: RefundSnapshot = {
      id: `re_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      status: this.refundStatus,
      amount: p.amountMinor,
      currency: "gbp",
      paymentIntentId: p.paymentIntentId,
      metadata: {
        refund_payment_id: p.refundPaymentId,
        reservation_id: p.reservationId,
        idempotency_key: p.idempotencyKey,
      },
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  async createCheckoutSession(p: CreateCheckoutParams) {
    const existing = this.byIdempotencyKey.get(p.idempotencyKey);
    if (existing) return this.sessions.get(existing)!;
    this.created.push(p);
    const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
    const session: CheckoutSessionSnapshot = {
      id,
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: p.amountMinor,
      currency: p.currency.toLowerCase(),
      clientReferenceId: p.reservationId,
      paymentIntentId: null,
      url: `https://checkout.stripe.test/${id}`,
      metadata: {
        reservation_id: p.reservationId,
        payment_id: p.paymentId,
        public_ref: p.publicRef,
      },
      expiresAt: p.expiresAt,
    };
    this.sessions.set(id, session);
    this.byIdempotencyKey.set(p.idempotencyKey, id);
    return session;
  }

  async retrieveCheckoutSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("No such session");
    return s;
  }

  async retrieveRefund(id: string) {
    const r = this.refunds.get(id);
    if (!r) throw new Error("No such refund");
    return { ...r };
  }

  async expireCheckoutSession(id: string) {
    const s = this.sessions.get(id);
    if (s?.status === "open") {
      s.status = "expired";
      this.expired.push(id);
    }
  }

  /** Simulates the guest completing payment on Stripe's page. */
  pay(
    id: string,
    overrides: Partial<CheckoutSessionSnapshot> = {},
  ): CheckoutSessionSnapshot {
    const s = this.sessions.get(id)!;
    Object.assign(s, {
      status: "complete",
      paymentStatus: "paid",
      paymentIntentId: `pi_test_${id.slice(-8)}`,
      ...overrides,
    });
    return { ...s };
  }

  latest(): CheckoutSessionSnapshot {
    return [...this.sessions.values()].at(-1)!;
  }
}
