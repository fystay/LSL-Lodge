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
import {
  conflictingBlocks,
  loadBlocks,
  type BlockSource,
} from "./availability";

/**
 * Owner and guest actions on existing bookings that don't depend on a
 * cancellation policy. None of them calculates or promises a refund: when
 * money has been paid, the booking is flagged "refund decision needed" and
 * the owner decides (refunds: src/server/payments/refunds.ts).
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

/**
 * The guest's own action from their booking page. Unpaid requests and
 * approvals are withdrawn at once (nothing is owed either way). A paid
 * booking is only marked "cancellation requested" and the owner alerted:
 * what happens next depends on the owner's policy.
 */
export async function guestCancel(
  db: Database,
  input: { propertyId: string; reservationId: string; now?: Date },
): Promise<
  | { ok: true; outcome: "WITHDRAWN"; openSessions: string[] }
  | { ok: true; outcome: "REQUESTED" }
  | { ok: false; reason: "NOT_FOUND" | "NOT_ALLOWED" }
> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    const paid = (await netPaid(tx, r.id)) > 0;
    if ((r.status === "REQUESTED" || r.status === "APPROVED") && !paid) {
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
        return { ok: false, reason: "NOT_ALLOWED" } as const;
      await tx
        .update(reservations)
        .set({ status: "CANCELLED", cancelledAt: now, holdExpiresAt: null })
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
          and(eq(payments.reservationId, r.id), eq(payments.status, "PENDING")),
        )
        .returning({ sessionId: payments.stripeCheckoutSessionId });
      await audit(tx, "reservation.withdrawn_by_guest", r.id, null, {
        previousStatus: r.status,
      });
      await enqueueForReservation(tx, r.id, ["owner_booking_withdrawn"]);
      return {
        ok: true,
        outcome: "WITHDRAWN",
        openSessions: open
          .map((o) => o.sessionId)
          .filter((s): s is string => Boolean(s)),
      } as const;
    }
    if (["CONFIRMED", "PAYMENT_DUE"].includes(r.status)) {
      if (!r.cancellationRequestedAt) {
        await tx
          .update(reservations)
          .set({ cancellationRequestedAt: now })
          .where(eq(reservations.id, r.id));
        await audit(tx, "reservation.cancellation_requested", r.id, null);
        await enqueueForReservation(tx, r.id, ["owner_cancellation_requested"]);
      }
      return { ok: true, outcome: "REQUESTED" } as const;
    }
    return { ok: false, reason: "NOT_ALLOWED" } as const;
  });
}
