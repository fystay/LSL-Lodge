import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db/client";
import {
  auditLogs,
  payments,
  properties,
  reservations,
} from "@/server/db/schema";
import type { PaymentGateway, RefundSnapshot } from "./gateway";

/**
 * Owner-initiated refunds. Policy-free by design: the owner chooses the
 * amount (no eligibility or amount is ever calculated here, because no
 * cancellation policy has been approved). The only rules are mechanical:
 * a refund needs a verified charge, can't exceed what's left of it, and is
 * issued through Stripe with an idempotency key.
 *
 * Refund rows are `payments` with kind REFUND, linked to the charge.
 * Stripe's response, and later `refund.*` webhooks, move them forward only
 * (PENDING → PROCESSING/REQUIRES_ACTION → SUCCEEDED/FAILED/CANCELED).
 * A cancelled reservation becomes REFUND_PENDING while refunds are in
 * flight and REFUNDED once everything paid has been returned. A refund on a
 * booking that still stands (e.g. a duplicate payment) leaves its status
 * alone.
 */

const IN_FLIGHT = ["PENDING", "PROCESSING", "REQUIRES_ACTION"] as const;
const COUNTS_AGAINST = [...IN_FLIGHT, "SUCCEEDED"] as const;

export type RefundResult =
  | { ok: true; status: string }
  | {
      ok: false;
      reason:
        "NOT_FOUND" | "NOT_REFUNDABLE" | "INVALID_AMOUNT" | "PROVIDER_ERROR";
      refundableMinor?: number;
    };

/** What's left to refund on a charge. */
async function refundable(
  tx: Transaction,
  charge: typeof payments.$inferSelect,
) {
  const [{ taken }] = await tx
    .select({
      taken: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.refundOfPaymentId, charge.id),
        inArray(payments.status, [...COUNTS_AGAINST]),
      ),
    );
  return charge.amountMinor - taken;
}

export async function issueRefund(
  db: Database,
  gateway: PaymentGateway,
  input: {
    propertyId: string;
    reservationId: string;
    chargePaymentId: string;
    amountMinor: number;
    actor: string;
  },
): Promise<RefundResult> {
  const prepared = await db.transaction(async (tx) => {
    await tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.id, input.propertyId))
      .for("update");
    const [r] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.id, input.reservationId),
          eq(reservations.propertyId, input.propertyId),
        ),
      )
      .for("update");
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    const [charge] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.id, input.chargePaymentId),
          eq(payments.reservationId, r.id),
          eq(payments.kind, "CHARGE"),
        ),
      )
      .for("update");
    if (
      !charge ||
      charge.status !== "SUCCEEDED" ||
      !charge.stripePaymentIntentId
    )
      return { ok: false, reason: "NOT_REFUNDABLE" } as const;
    const left = await refundable(tx, charge);
    if (
      !Number.isInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.amountMinor > left
    )
      return {
        ok: false,
        reason: "INVALID_AMOUNT",
        refundableMinor: left,
      } as const;

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(eq(payments.refundOfPaymentId, charge.id));
    const [refund] = await tx
      .insert(payments)
      .values({
        reservationId: r.id,
        kind: "REFUND",
        purpose: charge.purpose,
        status: "PENDING",
        amountMinor: input.amountMinor,
        currency: charge.currency,
        idempotencyKey: `refund:${charge.id}:${n + 1}`,
        refundOfPaymentId: charge.id,
        initiatedBy: input.actor,
      })
      .returning();
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.actor,
      action: "payment.refund_requested",
      targetType: "reservation",
      targetId: r.id,
      metadata: {
        chargePaymentId: charge.id,
        refundPaymentId: refund.id,
        amountMinor: input.amountMinor,
      },
    });
    return { ok: true, refund, charge, r } as const;
  });
  if (!prepared.ok) return prepared;

  let snapshot: RefundSnapshot;
  try {
    snapshot = await gateway.createRefund({
      paymentIntentId: prepared.charge.stripePaymentIntentId!,
      amountMinor: prepared.refund.amountMinor,
      refundPaymentId: prepared.refund.id,
      reservationId: prepared.r.id,
      idempotencyKey: prepared.refund.idempotencyKey,
    });
  } catch {
    // Stripe unreachable or refused: nothing moved. Record it so the
    // amount is available again; the owner can retry.
    await db
      .update(payments)
      .set({ status: "FAILED", failureCode: "REFUND_REQUEST_FAILED" })
      .where(eq(payments.id, prepared.refund.id));
    console.error("refund.create_failed", {
      refundPaymentId: prepared.refund.id,
    });
    return { ok: false, reason: "PROVIDER_ERROR" };
  }
  const status = await applyRefundSnapshot(db, snapshot);
  return { ok: true, status: status ?? "PENDING" };
}

const RANK: Record<string, number> = {
  PENDING: 0,
  PROCESSING: 1,
  REQUIRES_ACTION: 1,
  SUCCEEDED: 2,
  FAILED: 2,
  CANCELED: 2,
};

const fromStripe = (status: RefundSnapshot["status"]) =>
  ({
    pending: "PROCESSING",
    requires_action: "REQUIRES_ACTION",
    succeeded: "SUCCEEDED",
    failed: "FAILED",
    canceled: "CANCELED",
  })[status] as
    "PROCESSING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED";

/**
 * Applies Stripe's view of a refund (from the create response or a
 * `refund.*` webhook). Only ever moves a refund forward; returns its status,
 * or null if the refund isn't one of ours.
 */
export async function applyRefundSnapshot(
  db: Database | Transaction,
  snapshot: RefundSnapshot,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const id = snapshot.metadata.refund_payment_id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.kind, "REFUND")))
      .for("update");
    if (!row || (row.stripeRefundId && row.stripeRefundId !== snapshot.id))
      return null;
    const next = fromStripe(snapshot.status);
    const status =
      RANK[next] >= RANK[row.status] && row.status !== next ? next : row.status;
    await tx
      .update(payments)
      .set({
        stripeRefundId: snapshot.id,
        status,
        succeededAt: status === "SUCCEEDED" ? new Date() : row.succeededAt,
      })
      .where(eq(payments.id, row.id));
    if (status !== row.status)
      await tx.insert(auditLogs).values({
        actorType: "WEBHOOK",
        action: `payment.refund_${status.toLowerCase()}`,
        targetType: "reservation",
        targetId: row.reservationId,
        metadata: { refundPaymentId: row.id, amountMinor: row.amountMinor },
      });
    await settleAfterRefund(tx, row.reservationId);
    return status;
  });
}

/** Moves a cancelled reservation through REFUND_PENDING/REFUNDED and clears settled refund flags. */
async function settleAfterRefund(tx: Transaction, reservationId: string) {
  const rows = await tx
    .select()
    .from(payments)
    .where(eq(payments.reservationId, reservationId));
  const charges = rows.filter(
    (p) => p.kind === "CHARGE" && p.status === "SUCCEEDED",
  );
  const refunds = rows.filter((p) => p.kind === "REFUND");
  const refundedOf = (chargeId: string) =>
    refunds
      .filter(
        (r) => r.refundOfPaymentId === chargeId && r.status === "SUCCEEDED",
      )
      .reduce((sum, r) => sum + r.amountMinor, 0);
  const inFlight = refunds.some((r) =>
    (IN_FLIGHT as readonly string[]).includes(r.status),
  );
  const fullyRefunded =
    charges.length > 0 &&
    charges.every((c) => refundedOf(c.id) >= c.amountMinor);

  const [r] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .for("update");
  // A refund-required flag is settled once every flagged charge is refunded.
  const flagged = charges.filter((c) =>
    c.failureCode?.endsWith("REFUND_REQUIRED"),
  );
  const flagsSettled =
    flagged.length > 0 &&
    flagged.every((c) => refundedOf(c.id) >= c.amountMinor);
  const clearReason =
    (r.reviewReason?.endsWith("REFUND_REQUIRED") && flagsSettled) ||
    (r.reviewReason === "CANCELLED_REFUND_DECISION" && fullyRefunded);
  if (clearReason)
    await tx
      .update(reservations)
      .set({ reviewReason: null })
      .where(eq(reservations.id, reservationId));

  if (r.status === "CANCELLED" && (inFlight || fullyRefunded))
    await tx
      .update(reservations)
      .set({ status: "REFUND_PENDING" })
      .where(eq(reservations.id, reservationId));
  if (
    (r.status === "CANCELLED" || r.status === "REFUND_PENDING") &&
    !inFlight &&
    fullyRefunded
  )
    await tx
      .update(reservations)
      .set({ status: "REFUNDED" })
      .where(eq(reservations.id, reservationId));
}

/** Charges on a reservation with what's still refundable, for the admin page. */
export async function refundableCharges(db: Database, reservationId: string) {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.reservationId, reservationId));
  return rows
    .filter((p) => p.kind === "CHARGE" && p.status === "SUCCEEDED")
    .map((c) => {
      const taken = rows
        .filter(
          (r) =>
            r.refundOfPaymentId === c.id &&
            (COUNTS_AGAINST as readonly string[]).includes(r.status),
        )
        .reduce((sum, r) => sum + r.amountMinor, 0);
      return { charge: c, refundableMinor: c.amountMinor - taken };
    });
}
