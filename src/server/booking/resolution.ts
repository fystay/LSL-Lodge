import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
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
import { confirmationColumns, refundEligible } from "./cancellation-policy";

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
        reviewReason: null,
        holdExpiresAt: null,
        // The 24 hours start now, unless the booking was confirmed before.
        ...confirmationColumns(now),
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
        | "NOT_FOUND"
        | "NOT_ALLOWED"
        | "PAYMENT_PROCESSING"
        | "ACK_REQUIRED"
        | "INVALID_RECEIVED_TIME";
    };

/**
 * A guest's cancellation, under the host's policy
 * (src/server/booking/cancellation-policy.ts). Guests ask the owner to
 * cancel (the booking page says "contact the owner"); the owner records it
 * with `recordedBy` and the time the guest's request reached them
 * (`receivedAt`, e.g. the time on their email). Eligibility is decided by
 * that time, never by when the owner gets round to recording it. The
 * received time can't be in the future or before the booking was made.
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
    /** When the guest's cancellation request reached us. */
    receivedAt?: Date;
    /** Set when the owner records a cancellation the guest asked for. */
    recordedBy?: { actor: string; at: Date };
  },
): Promise<GuestCancelResult> {
  const now = input.receivedAt ?? input.recordedBy?.at ?? new Date();
  const actionAt = input.recordedBy?.at ?? now;
  const actor = input.recordedBy?.actor ?? null;
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    if (
      input.recordedBy &&
      (now.getTime() > actionAt.getTime() ||
        // Owners enter times to the minute, so compare at that precision.
        now.getTime() < Math.floor(r.requestedAt.getTime() / 60_000) * 60_000)
    )
      return { ok: false, reason: "INVALID_RECEIVED_TIME" } as const;
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
          cancelledAt: actionAt,
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
      await audit(tx, "reservation.hold_released_by_guest", r.id, actor, {
        previousStatus: r.status,
        ...(actor ? { recordedForGuest: true } : {}),
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
        cancelledAt: actionAt,
        cancelledBy: "GUEST",
        cancellationRequestedAt: now,
        holdExpiresAt: null,
      })
      .where(eq(reservations.id, r.id));
    await release();
    const refund = eligible
      ? await queueFullRefund(tx, r.id, "GUEST_POLICY", now)
      : { refundIds: [], totalMinor: 0 };
    await audit(
      tx,
      actor
        ? "reservation.cancelled_at_guest_request"
        : "reservation.cancelled_by_guest",
      r.id,
      actor,
      {
        // When the request reached us: entered by the owner (from the
        // guest's email or message) or, for a request made on the site,
        // the server's own clock. Eligibility is decided on this.
        requestReceivedAt: now.toISOString(),
        requestTimeSource: actor ? "OWNER_ENTERED" : "SERVER_CLOCK",
        // When the cancellation was actually recorded (server clock). The
        // audit row's own created_at is the database's time of writing.
        recordedAt: actionAt.toISOString(),
        freeCancellationUntil: r.freeCancellationUntil?.toISOString() ?? null,
        refundEligible: eligible,
        refundMinor: refund.totalMinor,
      },
    );
    // The owner recorded it themselves, so only the guest is told.
    await enqueueForReservation(
      tx,
      r.id,
      actor
        ? ["guest_cancellation_confirmed"]
        : ["guest_cancellation_confirmed", "owner_guest_cancelled"],
    );
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

/**
 * Releases an unpaid hold straight away when the guest can't continue to
 * payment: Stripe Checkout couldn't be opened, or the guest left Stripe's
 * page ("back"). Without this their own hold would block the same dates
 * for up to 30 minutes, and the booking page has no "pay again" button.
 *
 * Only a PENDING_PAYMENT hold with no payment received or being processed
 * is released. For a guest leaving Checkout, `paymentId` must be the
 * payment attempt that sent them there (it is in Stripe's cancel link and
 * isn't guessable), so a third-party link can't release someone's hold.
 * Idempotent.
 */
export async function releaseHoldBeforePayment(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    cause: "CHECKOUT_UNAVAILABLE" | "GUEST_LEFT_CHECKOUT";
    paymentId?: string;
    now?: Date;
  },
): Promise<{ released: boolean; openSessions: string[] }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lock(tx, input.propertyId, input.reservationId);
    if (!r || r.status !== "PENDING_PAYMENT")
      return { released: false, openSessions: [] };
    const rows = await tx
      .select()
      .from(payments)
      .where(eq(payments.reservationId, r.id));
    if (
      input.paymentId &&
      !rows.some((p) => p.id === input.paymentId && p.kind === "CHARGE")
    )
      return { released: false, openSessions: [] };
    if (rows.some((p) => p.status === "SUCCEEDED" || p.status === "PROCESSING"))
      return { released: false, openSessions: [] };

    await tx
      .update(reservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledBy: input.cause === "GUEST_LEFT_CHECKOUT" ? "GUEST" : "SYSTEM",
        holdExpiresAt: null,
        // Retire the form's idempotency key so trying again from the same
        // page creates a fresh hold instead of replaying this one.
        idempotencyKey: sql`${reservations.idempotencyKey} || ':released'`,
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
        and(eq(payments.reservationId, r.id), eq(payments.status, "PENDING")),
      )
      .returning({ sessionId: payments.stripeCheckoutSessionId });
    await tx.insert(auditLogs).values({
      actorType: input.cause === "GUEST_LEFT_CHECKOUT" ? "GUEST" : "SYSTEM",
      action: "reservation.hold_released_before_payment",
      targetType: "reservation",
      targetId: r.id,
      metadata: { cause: input.cause },
    });
    return {
      released: true,
      openSessions: open
        .map((o) => o.sessionId)
        .filter((s): s is string => Boolean(s)),
    };
  });
}
