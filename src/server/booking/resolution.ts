import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import type { Database, Transaction } from "@/server/db/client";
import {
  auditLogs,
  paymentScheduleItems,
  payments,
  properties,
  reservations,
} from "@/server/db/schema";
import { enqueueForReservation } from "@/server/notifications/outbox";
import { queueFullRefund } from "@/server/payments/refunds";
import {
  conflictingBlocks,
  loadBlocks,
  type BlockSource,
} from "./availability";
import { refundEligible } from "./cancellation-policy";

/**
 * Owner and guest actions on existing bookings. Guest cancellations follow
 * the host's 24-hour policy (guestCancel). When the OWNER cancels a paid
 * booking, the policy doesn't say what's owed, so the booking is flagged
 * "refund decision needed" and the owner chooses the refund
 * (src/server/payments/refunds.ts).
 *
 * Lock order matches every other booking write: property, then reservation.
 */

async function lock(
  tx: Transaction,
  propertyId: string,
  reservationId: string,
) {
  await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .for("update");
  const [r] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.id, reservationId),
        eq(reservations.propertyId, propertyId),
      ),
    )
    .for("update");
  return r ?? null;
}

/** Money received and not refunded, from verified payment records. */
async function netPaid(
  tx: Transaction,
  reservationId: string,
): Promise<number> {
  const rows = await tx
    .select()
    .from(payments)
    .where(eq(payments.reservationId, reservationId));
  const charged = rows
    .filter((p) => p.kind === "CHARGE" && p.status === "SUCCEEDED")
    .reduce((s, p) => s + p.amountMinor, 0);
  const refunded = rows
    .filter((p) => p.kind === "REFUND" && p.status === "SUCCEEDED")
    .reduce((s, p) => s + p.amountMinor, 0);
  return charged - refunded;
}

async function audit(
  tx: Transaction,
  action: string,
  reservationId: string,
  actor: string | null,
  metadata: Record<string, unknown> = {},
) {
  await tx.insert(auditLogs).values({
    actorType: actor ? "OWNER" : "GUEST",
    actorId: actor,
    action,
    targetType: "reservation",
    targetId: reservationId,
    metadata,
  });
}

export type ResolveResult =
  | { ok: true }
  | {
      ok: false;
      reason: "NOT_FOUND" | "NOT_ALLOWED" | "NOT_PAID_IN_FULL";
    }
  | { ok: false; reason: "CONFLICT"; sources: BlockSource[] };

/**
 * Confirms a booking held for review (e.g. a payment that arrived after the
 * deadline, or a calendar clash the owner has resolved). Only if verified
 * payments, net of refunds, cover the agreed total and nothing else now
 * overlaps the dates. Never confirms an unpaid booking.
 */
export async function confirmReviewedBooking(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    actor: string;
    now?: Date;
  },
): Promise<ResolveResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    if (r.status !== "REQUIRES_REVIEW")
      return { ok: false, reason: "NOT_ALLOWED" } as const;
    if ((await netPaid(tx, r.id)) < r.totalMinor)
      return { ok: false, reason: "NOT_PAID_IN_FULL" } as const;
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, r.propertyId));
    const stay = { start: r.checkIn as IsoDate, end: r.checkOut as IsoDate };
    const others = (
      await loadBlocks(tx, r.propertyId, stay, property.turnoverNights, now)
    ).filter((b) => b.id !== r.id);
    const clashes = conflictingBlocks(others, stay, property.turnoverNights);
    if (clashes.length > 0)
      return {
        ok: false,
        reason: "CONFLICT",
        sources: [...new Set(clashes.map((c) => c.source))],
      } as const;

    await tx
      .update(reservations)
      .set({
        status: "CONFIRMED",
        confirmedAt: now,
        reviewReason: null,
        holdExpiresAt: null,
      })
      .where(eq(reservations.id, r.id));
    await audit(tx, "reservation.confirmed_after_review", r.id, input.actor, {
      previousReason: r.reviewReason,
    });
    await enqueueForReservation(tx, r.id, [
      "booking_confirmed",
      "owner_booking_confirmed",
    ]);
    return { ok: true } as const;
  });
}

const OWNER_CANCELLABLE = [
  "APPROVED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "REQUIRES_REVIEW",
] as const;

/**
 * The owner cancels a booking. Frees the dates, cancels anything still
 * scheduled and any open payment attempt (its Stripe session is returned
 * for the caller to expire). If money was received, flags the booking for
 * the owner's refund decision. Requests are declined, not cancelled.
 */
export async function cancelByOwner(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    actor: string;
    ownerNote?: string | null;
    now?: Date;
  },
): Promise<
  | { ok: true; openSessions: string[]; paid: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ALLOWED" }
> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    if (!(OWNER_CANCELLABLE as readonly string[]).includes(r.status))
      return { ok: false, reason: "NOT_ALLOWED" } as const;
    const paid = (await netPaid(tx, r.id)) > 0;
    await tx
      .update(reservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledBy: `OWNER:${input.actor}`,
        holdExpiresAt: null,
        reviewReason: paid ? "CANCELLED_REFUND_DECISION" : null,
        ownerNote: input.ownerNote?.trim().slice(0, 1000) || r.ownerNote,
      })
      .where(eq(reservations.id, r.id));
    await tx
      .update(paymentScheduleItems)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(paymentScheduleItems.reservationId, r.id),
          ne(paymentScheduleItems.status, "PAID"),
        ),
      );
    const open = await tx
      .update(payments)
      .set({ status: "CANCELED" })
      .where(
        and(
          eq(payments.reservationId, r.id),
          inArray(payments.status, ["PENDING"]),
        ),
      )
      .returning({ sessionId: payments.stripeCheckoutSessionId });
    await audit(tx, "reservation.cancelled_by_owner", r.id, input.actor, {
      previousStatus: r.status,
      paid,
    });
    await enqueueForReservation(tx, r.id, ["booking_cancelled"]);
    return {
      ok: true,
      paid,
      openSessions: open
        .map((o) => o.sessionId)
        .filter((s): s is string => Boolean(s)),
    } as const;
  });
}

/**
 * Clears a "refund required"/"refund decision" flag after the owner has
 * dealt with it (for example refunded in the Stripe dashboard, or decided
 * not to refund). The note is kept in the audit log.
 */
export async function markFlagResolved(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    actor: string;
    note: string;
  },
): Promise<ResolveResult> {
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    // A booking under review must be confirmed or cancelled, not just cleared.
    if (!r.reviewReason || r.status === "REQUIRES_REVIEW")
      return { ok: false, reason: "NOT_ALLOWED" } as const;
    await tx
      .update(reservations)
      .set({ reviewReason: null })
      .where(eq(reservations.id, r.id));
    await audit(tx, "reservation.flag_resolved", r.id, input.actor, {
      reason: r.reviewReason,
      note: input.note.trim().slice(0, 500),
    });
    return { ok: true } as const;
  });
}

export type GuestCancelResult =
  | { ok: true; outcome: "HOLD_RELEASED"; openSessions: string[] }
  | {
      ok: true;
      outcome: "CANCELLED_WITH_REFUND";
      refundIds: string[];
      refundMinor: number;
    }
  | { ok: true; outcome: "CANCELLED_NO_REFUND" }
  | {
      ok: false;
      reason:
        "NOT_FOUND" | "NOT_ALLOWED" | "PAYMENT_PROCESSING" | "ACK_REQUIRED";
    };

/**
 * The guest cancels from their booking page, under the host's policy
 * (src/server/booking/cancellation-policy.ts):
 *
 * - An unpaid hold is simply released.
 * - A paid booking cancelled STRICTLY BEFORE `freeCancellationUntil`
 *   (`receivedAt` is when the server received the request) is cancelled and
 *   everything paid is queued for refund in the same transaction. The
 *   caller then sends the refunds (src/server/payments/refunds.ts).
 * - A paid booking cancelled at or after the deadline is cancelled without
 *   a refund, but only if the guest explicitly acknowledged that
 *   (`acknowledgeNoRefund`); otherwise nothing changes.
 *
 * The dates are released either way. Bookings under review, or with a
 * payment still settling, can't be cancelled here (the owner handles them).
 */
export async function guestCancel(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    acknowledgeNoRefund?: boolean;
    receivedAt?: Date;
  },
): Promise<GuestCancelResult> {
  const now = input.receivedAt ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    const processing = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.reservationId, r.id),
          eq(payments.status, "PROCESSING"),
        ),
      );
    if (processing.length > 0)
      return { ok: false, reason: "PAYMENT_PROCESSING" } as const;

    const release = async () => {
      await tx
        .update(paymentScheduleItems)
        .set({ status: "CANCELLED" })
        .where(
          and(
            eq(paymentScheduleItems.reservationId, r.id),
            ne(paymentScheduleItems.status, "PAID"),
          ),
        );
    };

    // Unpaid: release the hold (also covers bookings from the old request flow).
    if (
      ["PENDING_PAYMENT", "REQUESTED", "APPROVED"].includes(r.status) &&
      (await netPaid(tx, r.id)) === 0
    ) {
      await tx
        .update(reservations)
        .set({
          status: "CANCELLED",
          cancelledAt: now,
          cancelledBy: "GUEST",
          holdExpiresAt: null,
        })
        .where(eq(reservations.id, r.id));
      await release();
      const open = await tx
        .update(payments)
        .set({ status: "CANCELED" })
        .where(
          and(eq(payments.reservationId, r.id), eq(payments.status, "PENDING")),
        )
        .returning({ sessionId: payments.stripeCheckoutSessionId });
      await audit(tx, "reservation.hold_released_by_guest", r.id, null, {
        previousStatus: r.status,
      });
      return {
        ok: true,
        outcome: "HOLD_RELEASED",
        openSessions: open
          .map((o) => o.sessionId)
          .filter((s): s is string => Boolean(s)),
      } as const;
    }

    if (r.status !== "CONFIRMED" && r.status !== "PAYMENT_DUE")
      return { ok: false, reason: "NOT_ALLOWED" } as const;

    const eligible = refundEligible(r.freeCancellationUntil, now);
    if (!eligible && !input.acknowledgeNoRefund)
      return { ok: false, reason: "ACK_REQUIRED" } as const;

    await tx
      .update(reservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledBy: "GUEST",
        holdExpiresAt: null,
      })
      .where(eq(reservations.id, r.id));
    await release();
    const refund = eligible
      ? await queueFullRefund(tx, r.id, "GUEST_POLICY", now)
      : { refundIds: [], totalMinor: 0 };
    await audit(tx, "reservation.cancelled_by_guest", r.id, null, {
      receivedAt: now.toISOString(),
      freeCancellationUntil: r.freeCancellationUntil?.toISOString() ?? null,
      refundEligible: eligible,
      refundMinor: refund.totalMinor,
    });
    await enqueueForReservation(tx, r.id, [
      "guest_cancellation_confirmed",
      "owner_guest_cancelled",
    ]);
    return eligible
      ? ({
          ok: true,
          outcome: "CANCELLED_WITH_REFUND",
          refundIds: refund.refundIds,
          refundMinor: refund.totalMinor,
        } as const)
      : ({ ok: true, outcome: "CANCELLED_NO_REFUND" } as const);
  });
}
