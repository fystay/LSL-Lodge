import "server-only";
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { auditLogs, payments } from "@/server/db/schema";
import { applyCheckoutSession } from "./checkout";
import type { PaymentGateway } from "./gateway";
import { applyRefundSnapshot } from "./refunds";

/**
 * Stripe reconciliation: catches up on webhooks that never arrived (or
 * arrived while the site was down). Payments and refunds still unsettled
 * here a while after they started are re-read from Stripe and applied
 * through the same idempotent code as the webhook, so a missed
 * `checkout.session.completed` still confirms (or routes to review, or
 * refunds) the booking, and a missed `refund.*` still settles the refund.
 * Never creates payments or refunds; never trusts anything but Stripe's
 * server-side record.
 */

/** Leave recent payments to the webhook; look back this far at most. */
const MIN_AGE_MS = 10 * 60_000;
const LOOKBACK_MS = 3 * 24 * 3_600_000;
const BATCH = 50;

export interface ReconcileResult {
  charges: number;
  chargesChanged: number;
  refunds: number;
  refundsChanged: number;
  errors: number;
}

export async function reconcilePayments(
  db: Database,
  gateway: PaymentGateway | null,
  now = new Date(),
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    charges: 0,
    chargesChanged: 0,
    refunds: 0,
    refundsChanged: 0,
    errors: 0,
  };
  if (!gateway) return result;
  const olderThan = new Date(now.getTime() - MIN_AGE_MS);
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const charges = await db
    .select({
      id: payments.id,
      status: payments.status,
      reservationId: payments.reservationId,
      session: payments.stripeCheckoutSessionId,
    })
    .from(payments)
    .where(
      and(
        eq(payments.kind, "CHARGE"),
        inArray(payments.status, ["PENDING", "PROCESSING"]),
        isNotNull(payments.stripeCheckoutSessionId),
        lte(payments.createdAt, olderThan),
        gte(payments.createdAt, since),
      ),
    )
    .limit(BATCH);
  for (const charge of charges) {
    result.charges++;
    try {
      const session = await gateway.retrieveCheckoutSession(charge.session!);
      // Still open and unpaid: nothing to catch up on yet.
      if (session.status === "open") continue;
      const outcome = await applyCheckoutSession(db, session, now);
      const [after] = await db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, charge.id));
      if (after?.status !== charge.status) {
        result.chargesChanged++;
        await db.insert(auditLogs).values({
          actorType: "SYSTEM",
          action: "payment.reconciled",
          targetType: "reservation",
          targetId: charge.reservationId,
          metadata: {
            paymentId: charge.id,
            from: charge.status,
            to: after?.status ?? null,
            outcome,
          },
        });
      }
    } catch {
      result.errors++;
      console.error("stripe.reconcile_charge_failed", { paymentId: charge.id });
    }
  }

  const refunds = await db
    .select({
      id: payments.id,
      status: payments.status,
      refundId: payments.stripeRefundId,
    })
    .from(payments)
    .where(
      and(
        eq(payments.kind, "REFUND"),
        inArray(payments.status, ["PROCESSING", "REQUIRES_ACTION"]),
        isNotNull(payments.stripeRefundId),
        lte(payments.createdAt, olderThan),
        gte(payments.createdAt, since),
      ),
    )
    .limit(BATCH);
  for (const refund of refunds) {
    result.refunds++;
    try {
      const snapshot = await gateway.retrieveRefund(refund.refundId!);
      const status = await applyRefundSnapshot(db, snapshot);
      if (status && status !== refund.status) result.refundsChanged++;
    } catch {
      result.errors++;
      console.error("stripe.reconcile_refund_failed", { paymentId: refund.id });
    }
  }
  return result;
}
