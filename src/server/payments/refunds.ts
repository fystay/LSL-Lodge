import "server-only";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database, Transaction } from "@/server/db/client";
import {
  auditLogs,
  payments,
  properties,
  reservations,
} from "@/server/db/schema";
import { enqueueNotification } from "@/server/notifications/outbox";
import type { PaymentGateway, RefundSnapshot } from "./gateway";

/**
 * Refunds, through Stripe, for two sources:
 * - the cancellation policy: a guest who cancels strictly within 24 hours
 *   of the booking being confirmed gets everything they paid back,
 *   automatically
 *   (src/server/booking/resolution.ts), and a payment that lands on an
 *   already cancelled booking is returned in full;
 * - the owner, who may refund any amount up to what's left of a charge.
 *
 * Every refund is first written as a `payments` row (kind REFUND, PENDING)
 * in the same transaction as the decision, with a fixed idempotency key.
 * It is then sent to Stripe at once and, if Stripe can't be reached,
 * retried by the `process-refunds` job with backoff, always with the same
 * key, so a retry can never refund twice. After MAX_ATTEMPTS it is marked
 * FAILED and the owner is alerted.
 *
 * Stripe's response, and later `refund.*` webhooks, move a refund forward
 * only (PENDING → PROCESSING/REQUIRES_ACTION → SUCCEEDED/FAILED/CANCELED).
 * Only SUCCEEDED counts as refunded: nothing tells the guest the money is
 * back before Stripe says so. A cancelled reservation is REFUND_PENDING
 * while refunds are in flight and REFUNDED once everything paid is back.
 */

const IN_FLIGHT = ["PENDING", "PROCESSING", "REQUIRES_ACTION"] as const;
const COUNTS_AGAINST = [...IN_FLIGHT, "SUCCEEDED"] as const;
export const REFUND_MAX_ATTEMPTS = 6;

export type RefundResult =
  | { ok: true; status: string }
  | {
      ok: false;
      reason: "NOT_FOUND" | "NOT_REFUNDABLE" | "INVALID_AMOUNT";
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

/** Writes a PENDING refund row (inside the caller's transaction). */
async function queueRefund(
  tx: Transaction,
  charge: typeof payments.$inferSelect,
  amountMinor: number,
  initiatedBy: string,
  now: Date,
) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(eq(payments.refundOfPaymentId, charge.id));
  const [refund] = await tx
    .insert(payments)
    .values({
      reservationId: charge.reservationId,
      kind: "REFUND",
      purpose: charge.purpose,
      status: "PENDING",
      amountMinor,
      currency: charge.currency,
      idempotencyKey: `refund:${charge.id}:${n + 1}`,
      refundOfPaymentId: charge.id,
      initiatedBy,
      nextAttemptAt: now,
    })
    .returning();
  await tx.insert(auditLogs).values({
    actorType: initiatedBy.includes("@") ? "OWNER" : "SYSTEM",
    actorId: initiatedBy,
    action: "payment.refund_queued",
    targetType: "reservation",
    targetId: charge.reservationId,
    metadata: {
      chargePaymentId: charge.id,
      refundPaymentId: refund.id,
      amountMinor,
    },
  });
  return refund;
}

/**
 * Queues a refund of everything still refundable on a reservation's
 * verified charges (policy refunds and payments on cancelled bookings).
 * Returns the refund rows and the total.
 */
export async function queueFullRefund(
  tx: Transaction,
  reservationId: string,
  initiatedBy: string,
  now: Date,
): Promise<{ refundIds: string[]; totalMinor: number }> {
  const charges = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.reservationId, reservationId),
        eq(payments.kind, "CHARGE"),
        eq(payments.status, "SUCCEEDED"),
      ),
    )
    .for("update");
  const refundIds: string[] = [];
  let totalMinor = 0;
  for (const charge of charges) {
    if (!charge.stripePaymentIntentId) continue;
    const left = await refundable(tx, charge);
    if (left <= 0) continue;
    const refund = await queueRefund(tx, charge, left, initiatedBy, now);
    refundIds.push(refund.id);
    totalMinor += left;
  }
  await settleAfterRefund(tx, reservationId);
  return { refundIds, totalMinor };
}

/** Queues a refund of everything left on one charge (e.g. a duplicate or late payment). */
export async function queueChargeRefund(
  tx: Transaction,
  chargeId: string,
  initiatedBy: string,
  now: Date,
): Promise<string | null> {
  const [charge] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, chargeId), eq(payments.kind, "CHARGE")))
    .for("update");
  if (!charge || charge.status !== "SUCCEEDED" || !charge.stripePaymentIntentId)
    return null;
  const left = await refundable(tx, charge);
  if (left <= 0) return null;
  const refund = await queueRefund(tx, charge, left, initiatedBy, now);
  await settleAfterRefund(tx, charge.reservationId);
  return refund.id;
}

/** The owner refunds an amount of their choosing from one charge. */
export async function issueRefund(
  db: Database,
  gateway: PaymentGateway,
  input: {
    propertyId: string;
    reservationId: string;
    chargePaymentId: string;
    amountMinor: number;
    actor: string;
    now?: Date;
  },
): Promise<RefundResult> {
  const now = input.now ?? new Date();
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
    const refund = await queueRefund(
      tx,
      charge,
      input.amountMinor,
      input.actor,
      now,
    );
    await settleAfterRefund(tx, r.id);
    return { ok: true, refund } as const;
  });
  if (!prepared.ok) return prepared;
  const status = await sendRefund(db, gateway, prepared.refund.id, now);
  return { ok: true, status };
}

/**
 * Sends one queued refund to Stripe (same idempotency key every time).
 * On success applies Stripe's status; on failure schedules a retry, and
 * after REFUND_MAX_ATTEMPTS marks it FAILED and alerts the owner.
 */
export async function sendRefund(
  db: Database,
  gateway: PaymentGateway,
  refundId: string,
  now = new Date(),
): Promise<string> {
  const charge = alias(payments, "charge");
  const [row] = await db
    .select({
      refund: payments,
      charge: { intent: charge.stripePaymentIntentId },
    })
    .from(payments)
    .innerJoin(charge, eq(charge.id, payments.refundOfPaymentId))
    .where(eq(payments.id, refundId));
  if (!row) return "NOT_FOUND";
  const { refund } = row;
  if (refund.status !== "PENDING" || refund.stripeRefundId)
    return refund.status;
  if (!row.charge.intent) return refund.status;

  let snapshot: RefundSnapshot;
  try {
    snapshot = await gateway.createRefund({
      paymentIntentId: row.charge.intent,
      amountMinor: refund.amountMinor,
      refundPaymentId: refund.id,
      reservationId: refund.reservationId,
      idempotencyKey: refund.idempotencyKey,
    });
  } catch {
    const attempts = refund.providerAttempts + 1;
    const exhausted = attempts >= REFUND_MAX_ATTEMPTS;
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          providerAttempts: attempts,
          failureCode: "REFUND_REQUEST_FAILED",
          status: exhausted ? "FAILED" : "PENDING",
          nextAttemptAt: exhausted
            ? null
            : new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60_000),
        })
        .where(and(eq(payments.id, refund.id), eq(payments.status, "PENDING")));
      if (exhausted) {
        await tx
          .update(reservations)
          .set({ reviewReason: "REFUND_FAILED" })
          .where(eq(reservations.id, refund.reservationId));
        await enqueueNotification(tx, {
          template: "owner_refund_failed",
          reservationId: refund.reservationId,
          idempotencyKey: `owner_refund_failed:${refund.id}`,
        });
        await settleAfterRefund(tx, refund.reservationId);
      }
    });
    console.error("refund.create_failed", {
      refundPaymentId: refund.id,
      attempts,
    });
    return exhausted ? "FAILED" : "PENDING";
  }
  return (await applyRefundSnapshot(db, snapshot)) ?? "PENDING";
}

/** Sends refunds that are due (new, or waiting for a retry). Used by the job. */
export async function processPendingRefunds(
  db: Database,
  gateway: PaymentGateway | null,
  now = new Date(),
): Promise<{ sent: number; skipped: number }> {
  if (!gateway) return { sent: 0, skipped: 0 };
  const due = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.kind, "REFUND"),
        eq(payments.status, "PENDING"),
        isNull(payments.stripeRefundId),
        or(isNull(payments.nextAttemptAt), lte(payments.nextAttemptAt, now)),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const { id } of due) {
    const status = await sendRefund(db, gateway, id, now);
    if (status !== "PENDING") sent++;
  }
  return { sent, skipped: due.length - sent };
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
    // Stripe can fail a refund after it succeeded, never the reverse, and
    // webhooks can arrive out of order: failed and cancelled are final.
    const final = row.status === "FAILED" || row.status === "CANCELED";
    const status =
      !final && RANK[next] >= RANK[row.status] && row.status !== next
        ? next
        : row.status;
    await tx
      .update(payments)
      .set({
        stripeRefundId: snapshot.id,
        status,
        succeededAt: status === "SUCCEEDED" ? new Date() : row.succeededAt,
      })
      .where(eq(payments.id, row.id));
    if (status === "SUCCEEDED" && row.status !== "SUCCEEDED")
      await enqueueNotification(tx, {
        template: "refund_completed",
        reservationId: row.reservationId,
        idempotencyKey: `refund_completed:${row.id}`,
      });
    if (status !== row.status)
      await tx.insert(auditLogs).values({
        actorType: "WEBHOOK",
        action: `payment.refund_${status.toLowerCase()}`,
        targetType: "reservation",
        targetId: row.reservationId,
        metadata: { refundPaymentId: row.id, amountMinor: row.amountMinor },
      });
    // Stripe accepted the refund but then reported it failed (e.g. the card
    // was closed) or cancelled it: the guest is still owed the money. Flag
    // the booking, alert the owner; the amount becomes refundable again.
    if (
      status !== row.status &&
      (status === "FAILED" || status === "CANCELED")
    ) {
      await tx
        .update(payments)
        .set({ failureCode: "REFUND_FAILED_AT_PROVIDER" })
        .where(eq(payments.id, row.id));
      await tx
        .update(reservations)
        .set({ reviewReason: "REFUND_FAILED_AT_PROVIDER" })
        .where(
          and(
            eq(reservations.id, row.reservationId),
            isNull(reservations.reviewReason),
          ),
        );
      await enqueueNotification(tx, {
        template: "owner_refund_failed",
        reservationId: row.reservationId,
        idempotencyKey: `owner_refund_failed:${row.id}`,
      });
    }
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
  // Refunds under way that, once Stripe confirms, refund everything. A
  // partial refund leaves the booking CANCELLED rather than "refund pending".
  const inFlightOf = (chargeId: string) =>
    refunds
      .filter(
        (r) =>
          r.refundOfPaymentId === chargeId &&
          (IN_FLIGHT as readonly string[]).includes(r.status),
      )
      .reduce((sum, r) => sum + r.amountMinor, 0);
  const fullRefundUnderway =
    charges.length > 0 &&
    charges.every((c) => refundedOf(c.id) + inFlightOf(c.id) >= c.amountMinor);

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

  if (r.status === "CANCELLED" && fullRefundUnderway)
    await tx
      .update(reservations)
      .set({ status: "REFUND_PENDING" })
      .where(eq(reservations.id, reservationId));
  // A refund Stripe had confirmed was later reported failed: the booking is
  // no longer fully refunded.
  if (r.status === "REFUNDED" && !fullyRefunded)
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
