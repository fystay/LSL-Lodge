import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import type { Database, Executor, Transaction } from "@/server/db/client";
import {
  auditLogs,
  paymentScheduleItems,
  payments,
  properties,
  reservations,
} from "@/server/db/schema";
import { conflictingBlocks, loadBlocks } from "@/server/booking/availability";
import { enqueueForReservation } from "@/server/notifications/outbox";
import type { CheckoutSessionSnapshot, PaymentGateway } from "./gateway";

/**
 * Payment lifecycle for an approved request (or an instant-mode hold).
 *
 * - startCheckout: server-side only. Re-checks state, deadline and
 *   availability, records a PENDING payment for the amount due now (from the
 *   immutable schedule, never from the client), and creates a Stripe Checkout
 *   Session that cannot outlive the reservation's hold.
 * - applyCheckoutSession: the single place a payment is applied. Called from
 *   the verified webhook and from the guest's return page (which re-fetches
 *   the session from Stripe server-side; the redirect itself proves nothing).
 *   Idempotent: applying the same session twice changes nothing.
 *
 * A reservation is confirmed only if it was APPROVED (or an instant hold),
 * the hold has not lapsed, the amount, currency and reservation all match,
 * and no other calendar source now overlaps it. Anything else goes to the
 * owner as REQUIRES_REVIEW (or, if the dates were re-sold, the payment is
 * flagged for refund). Money is never silently kept or lost.
 */

/** Stripe accepts expires_at between 30 minutes and 24 hours ahead. */
const MIN_SESSION_MS = 31 * 60_000;
const MAX_SESSION_MS = 23 * 3_600_000;

const PAYABLE = ["APPROVED", "PENDING_PAYMENT"] as const;

export type StartCheckoutResult =
  | { ok: true; url: string; reused: boolean }
  | {
      ok: false;
      reason:
        | "NOT_PAYABLE"
        | "EXPIRED"
        | "ALREADY_PAID"
        | "UNAVAILABLE"
        | "PROVIDER_ERROR";
    };

export async function startCheckout(
  db: Database,
  gateway: PaymentGateway,
  input: {
    reservationId: string;
    baseUrl: string;
    now?: Date;
  },
): Promise<StartCheckoutResult> {
  const now = input.now ?? new Date();

  // 1. Under locks: validate, then record (or reuse) the payment attempt.
  const prepared = await db.transaction(async (tx) => {
    const r = await lockForPayment(tx, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_PAYABLE" } as const;
    if (!(PAYABLE as readonly string[]).includes(r.status))
      return {
        ok: false,
        reason: ["CONFIRMED", "PAYMENT_DUE"].includes(r.status)
          ? "ALREADY_PAID"
          : "NOT_PAYABLE",
      } as const;
    if (!r.holdExpiresAt || r.holdExpiresAt <= now)
      return { ok: false, reason: "EXPIRED" } as const;

    const [item] = await tx
      .select()
      .from(paymentScheduleItems)
      .where(
        and(
          eq(paymentScheduleItems.reservationId, r.id),
          ne(paymentScheduleItems.status, "PAID"),
          ne(paymentScheduleItems.status, "CANCELLED"),
        ),
      )
      .orderBy(asc(paymentScheduleItems.sequence))
      .limit(1);
    if (!item) return { ok: false, reason: "ALREADY_PAID" } as const;

    if (await hasExternalConflict(tx, r, now))
      return { ok: false, reason: "UNAVAILABLE" } as const;

    const open = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.reservationId, r.id),
          eq(payments.kind, "CHARGE"),
          inArray(payments.status, ["PENDING", "PROCESSING"]),
        ),
      );
    if (open.some((p) => p.status === "PROCESSING"))
      return { ok: false, reason: "NOT_PAYABLE" } as const;
    const reusable = open.find(
      (p) =>
        p.stripeCheckoutSessionId &&
        p.checkoutExpiresAt &&
        p.checkoutExpiresAt.getTime() - now.getTime() > 5 * 60_000,
    );
    if (reusable)
      return { ok: true, kind: "reuse", reuse: reusable, r } as const;

    // Retire stale attempts so only one session can ever be live (their
    // Stripe sessions are expired below, once this transaction commits).
    for (const p of open)
      await tx
        .update(payments)
        .set({ status: "CANCELED" })
        .where(eq(payments.id, p.id));
    const superseded = open
      .map((p) => p.stripeCheckoutSessionId)
      .filter((id): id is string => Boolean(id));

    const attempt = (
      await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payments)
        .where(eq(payments.reservationId, r.id))
    )[0].n;
    // The session may not outlive the hold, but Stripe needs >= 30 minutes:
    // if less remains, the hold is extended to cover the session, so a guest
    // mid-payment never loses the dates under them.
    const remaining = r.holdExpiresAt.getTime() - now.getTime();
    const sessionMs = Math.min(
      MAX_SESSION_MS,
      Math.max(MIN_SESSION_MS, remaining),
    );
    const checkoutExpiresAt = new Date(now.getTime() + sessionMs);
    if (checkoutExpiresAt > r.holdExpiresAt)
      await tx
        .update(reservations)
        .set({ holdExpiresAt: checkoutExpiresAt })
        .where(eq(reservations.id, r.id));

    const [payment] = await tx
      .insert(payments)
      .values({
        reservationId: r.id,
        scheduleItemId: item.id,
        kind: "CHARGE",
        purpose: item.purpose,
        status: "PENDING",
        amountMinor: item.amountMinor - item.paidMinor,
        currency: r.currency,
        idempotencyKey: `checkout:${r.id}:${item.id}:${attempt + 1}`,
        checkoutExpiresAt,
      })
      .returning();
    await tx.insert(auditLogs).values({
      actorType: "GUEST",
      action: "payment.checkout_started",
      targetType: "reservation",
      targetId: r.id,
      metadata: { paymentId: payment.id, amountMinor: payment.amountMinor },
    });
    return { ok: true, kind: "new", payment, r, superseded } as const;
  });

  if (!prepared.ok) return prepared;
  if (prepared.kind === "new")
    await expireSessions(gateway, prepared.superseded);

  // 2. Outside the transaction: talk to Stripe.
  try {
    if (prepared.kind === "reuse") {
      const session = await gateway.retrieveCheckoutSession(
        prepared.reuse.stripeCheckoutSessionId!,
      );
      if (session.status === "open" && session.url)
        return { ok: true, url: session.url, reused: true };
      // It ended (paid, or expired): settle it, then let the guest retry.
      await applyCheckoutSession(db, session, now);
      return { ok: false, reason: "NOT_PAYABLE" };
    }

    const { payment, r } = prepared;
    const refPath = `${input.baseUrl}/book/${r.publicRef}`;
    const session = await gateway.createCheckoutSession({
      reservationId: r.id,
      paymentId: payment.id,
      publicRef: r.publicRef,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      description: `Lodge on the Lake: ${r.checkIn} to ${r.checkOut} (${r.publicRef})`,
      customerEmail: r.guestEmail,
      successUrl: `${refPath}?payment=returned&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${refPath}?payment=cancelled`,
      expiresAt: payment.checkoutExpiresAt!,
      idempotencyKey: payment.idempotencyKey,
    });
    await db
      .update(payments)
      .set({ stripeCheckoutSessionId: session.id })
      .where(eq(payments.id, payment.id));
    if (!session.url) return { ok: false, reason: "PROVIDER_ERROR" };
    return { ok: true, url: session.url, reused: false };
  } catch (error) {
    // Logged without request details; the guest can safely retry (the
    // idempotency key returns the same session).
    console.error("checkout.start_failed", {
      reservationId: prepared.r.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "PROVIDER_ERROR" };
  }
}

export type ApplyOutcome =
  | "CONFIRMED"
  | "BALANCE_DUE"
  | "ALREADY_APPLIED"
  | "PROCESSING"
  | "SESSION_EXPIRED"
  | "NEEDS_REVIEW"
  | "REFUND_REQUIRED"
  | "MISMATCH"
  | "UNKNOWN_SESSION";

/**
 * Applies the verified state of a Checkout Session. `session` must come from
 * a signature-verified webhook or a server-side retrieve from Stripe.
 */
export async function applyCheckoutSession(
  db: Database | Transaction,
  session: CheckoutSessionSnapshot,
  now = new Date(),
): Promise<ApplyOutcome> {
  return db.transaction(async (tx) => {
    const reservationId = session.clientReferenceId;
    if (!reservationId || !/^[0-9a-f-]{36}$/i.test(reservationId))
      return "UNKNOWN_SESSION";
    const r = await lockForPayment(tx, reservationId);
    if (!r) return "UNKNOWN_SESSION";
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.stripeCheckoutSessionId, session.id),
          eq(payments.reservationId, r.id),
        ),
      )
      .for("update");
    // Also guards against a session created for a different reservation.
    if (!payment || session.metadata.payment_id !== payment.id)
      return "UNKNOWN_SESSION";
    if (payment.status === "SUCCEEDED") return "ALREADY_APPLIED";

    if (session.status === "expired") {
      if (payment.status === "PENDING")
        await tx
          .update(payments)
          .set({ status: "CANCELED" })
          .where(eq(payments.id, payment.id));
      return "SESSION_EXPIRED";
    }
    if (session.paymentStatus !== "paid") {
      if (session.status === "complete" && payment.status === "PENDING") {
        await tx
          .update(payments)
          .set({ status: "PROCESSING" })
          .where(eq(payments.id, payment.id));
        return "PROCESSING";
      }
      return payment.status === "PROCESSING" ? "PROCESSING" : "ALREADY_APPLIED";
    }

    // Paid. Record the money first, whatever happens to the booking.
    const amountMatches =
      session.amountTotal === payment.amountMinor &&
      session.currency?.toUpperCase() === payment.currency.toUpperCase();
    await tx
      .update(payments)
      .set({
        status: "SUCCEEDED",
        succeededAt: now,
        stripePaymentIntentId: session.paymentIntentId,
        failureCode: amountMatches ? null : "AMOUNT_MISMATCH",
      })
      .where(eq(payments.id, payment.id));
    await tx.insert(auditLogs).values({
      actorType: "WEBHOOK",
      action: "payment.succeeded",
      targetType: "reservation",
      targetId: r.id,
      metadata: {
        paymentId: payment.id,
        amountMinor: session.amountTotal,
        currency: session.currency,
      },
    });

    if (!amountMatches) return review(tx, r, "AMOUNT_MISMATCH", "MISMATCH");

    if (payment.scheduleItemId) {
      await tx
        .update(paymentScheduleItems)
        .set({
          paidMinor: sql`LEAST(${paymentScheduleItems.amountMinor}, ${paymentScheduleItems.paidMinor} + ${payment.amountMinor})`,
          status: sql`CASE WHEN ${paymentScheduleItems.paidMinor} + ${payment.amountMinor} >= ${paymentScheduleItems.amountMinor} THEN 'PAID'::schedule_item_status ELSE ${paymentScheduleItems.status} END`,
        })
        .where(eq(paymentScheduleItems.id, payment.scheduleItemId));
    }

    // Still APPROVED (or an instant hold) means nobody else can hold these
    // dates: any new booking must first expire this row, under the same lock.
    if (r.status === "CONFIRMED" || r.status === "PAYMENT_DUE")
      return review(tx, r, "DUPLICATE_PAYMENT", "NEEDS_REVIEW");
    if (!(PAYABLE as readonly string[]).includes(r.status))
      // Late payment on an expired or cancelled reservation.
      return review(tx, r, "PAYMENT_AFTER_EXPIRY", "NEEDS_REVIEW");
    if (r.status === "APPROVED" && !r.approvedAt)
      return review(tx, r, "NOT_APPROVED", "NEEDS_REVIEW");
    if (await hasExternalConflict(tx, r, now))
      return review(tx, r, "CALENDAR_CONFLICT", "NEEDS_REVIEW");

    const outstanding = await tx
      .select({ id: paymentScheduleItems.id })
      .from(paymentScheduleItems)
      .where(
        and(
          eq(paymentScheduleItems.reservationId, r.id),
          inArray(paymentScheduleItems.status, ["SCHEDULED", "OVERDUE"]),
        ),
      );
    const next = outstanding.length === 0 ? "CONFIRMED" : "PAYMENT_DUE";
    await tx
      .update(reservations)
      .set({ status: next, confirmedAt: now, holdExpiresAt: null })
      .where(eq(reservations.id, r.id));
    await tx.insert(auditLogs).values({
      actorType: "WEBHOOK",
      action: "reservation.confirmed",
      targetType: "reservation",
      targetId: r.id,
      metadata: { status: next },
    });
    await enqueueForReservation(tx, r.id, [
      "booking_confirmed",
      "owner_booking_confirmed",
    ]);
    return next === "CONFIRMED" ? "CONFIRMED" : "BALANCE_DUE";
  });
}

/** Marks a Checkout payment failed (async methods only; card fails inside Checkout). */
export async function markCheckoutFailed(
  db: Executor,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .update(payments)
    .set({ status: "FAILED", failureCode: "ASYNC_PAYMENT_FAILED" })
    .where(
      and(
        eq(payments.stripeCheckoutSessionId, sessionId),
        inArray(payments.status, ["PENDING", "PROCESSING"]),
      ),
    )
    .returning({ reservationId: payments.reservationId });
  for (const row of rows)
    await enqueueForReservation(db, row.reservationId, ["payment_failed"]);
  return rows.length > 0;
}

/**
 * After reservations expire, closes their still-open Checkout Sessions so the
 * guest can't pay into a lapsed booking. If Stripe can't be reached, a late
 * payment still can't confirm: applyCheckoutSession routes it to review.
 */
export async function cancelOpenCheckouts(
  db: Database,
  gateway: PaymentGateway | null,
  reservationIds: readonly string[],
) {
  if (reservationIds.length === 0) return;
  const open = await db
    .update(payments)
    .set({ status: "CANCELED" })
    .where(
      and(
        inArray(payments.reservationId, [...reservationIds]),
        eq(payments.status, "PENDING"),
      ),
    )
    .returning({ sessionId: payments.stripeCheckoutSessionId });
  if (gateway)
    await expireSessions(
      gateway,
      open.map((p) => p.sessionId).filter((id): id is string => Boolean(id)),
    );
}

/** Best effort: a session we can't expire still can't confirm a stale booking. */
export async function expireSessions(
  gateway: PaymentGateway,
  sessionIds: readonly string[],
) {
  for (const id of sessionIds) {
    try {
      await gateway.expireCheckoutSession(id);
    } catch {
      console.error("checkout.expire_failed", { sessionId: id });
    }
  }
}

// --- helpers --------------------------------------------------------------------

type ReservationRow = typeof reservations.$inferSelect;

/** Locks property then reservation, the same order as every booking write. */
async function lockForPayment(tx: Transaction, reservationId: string) {
  const [ref] = await tx
    .select({ propertyId: reservations.propertyId })
    .from(reservations)
    .where(eq(reservations.id, reservationId));
  if (!ref) return null;
  await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, ref.propertyId))
    .for("update");
  const [row] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .for("update");
  return row ?? null;
}

/** True if an owner block or imported busy period now overlaps the stay. */
async function hasExternalConflict(
  tx: Transaction,
  r: ReservationRow,
  now: Date,
): Promise<boolean> {
  const [property] = await tx
    .select({ turnoverNights: properties.turnoverNights })
    .from(properties)
    .where(eq(properties.id, r.propertyId));
  const stay = { start: r.checkIn as IsoDate, end: r.checkOut as IsoDate };
  const blocks = (
    await loadBlocks(tx, r.propertyId, stay, property.turnoverNights, now)
  ).filter((b) => b.id !== r.id);
  return conflictingBlocks(blocks, stay, property.turnoverNights).length > 0;
}

/**
 * Hands a paid-but-unconfirmable reservation to the owner. If its dates were
 * taken in the meantime the exclusion constraint refuses REQUIRES_REVIEW;
 * the reservation keeps its status and the payment is flagged for refund.
 */
async function review(
  tx: Transaction,
  r: ReservationRow,
  reason: string,
  outcome: ApplyOutcome,
): Promise<ApplyOutcome> {
  let result = outcome;
  try {
    await tx.transaction(async (sp) => {
      await sp
        .update(reservations)
        .set({ status: "REQUIRES_REVIEW", reviewReason: reason })
        .where(eq(reservations.id, r.id));
    });
  } catch (error) {
    if (pgCode(error) !== "23P01" && pgCode(error) !== "23514") throw error;
    // Dates re-sold (exclusion) or no legal path (e.g. DECLINED is terminal).
    await tx
      .update(reservations)
      .set({ reviewReason: `${reason}_REFUND_REQUIRED` })
      .where(eq(reservations.id, r.id));
    result = "REFUND_REQUIRED";
  }
  await tx.insert(auditLogs).values({
    actorType: "WEBHOOK",
    action:
      result === "REFUND_REQUIRED"
        ? "payment.refund_required"
        : "reservation.requires_review",
    targetType: "reservation",
    targetId: r.id,
    metadata: { reason, previousStatus: r.status },
  });
  await enqueueForReservation(tx, r.id, ["owner_payment_needs_review"]);
  return result;
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string")
      return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
