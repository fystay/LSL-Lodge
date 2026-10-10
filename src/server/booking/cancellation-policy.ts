/**
 * The host's cancellation policy (confirmed by the owner, October 2026):
 *
 *   Guests may cancel within 24 hours of their booking being paid and
 *   confirmed for a full refund. Cancellations after that are
 *   non-refundable.
 *
 * Rules, applied on the server only:
 * - The window starts at `confirmedAt`: the server time at which a verified
 *   payment (signed Stripe webhook, or a server-side fetch of the Checkout
 *   Session) first confirmed the booking. Not when the guest entered their
 *   details, the hold was created, Checkout was opened, or anything the
 *   guest's device reports.
 * - `freeCancellationUntil = confirmedAt + 24 hours`, written in the same
 *   update that confirms the booking. Both are set once: duplicate, delayed
 *   or out-of-order webhooks can't move them (application code only sets
 *   them while null; a database trigger refuses any later change, and a
 *   check constraint ties the deadline to confirmedAt).
 * - Before payment is confirmed there is no deadline yet; guests are told
 *   the 24 hours start once payment is confirmed, never shown a guess.
 * - Boundary: a cancellation is eligible only if the server receives it
 *   STRICTLY BEFORE `freeCancellationUntil`. One received exactly at the
 *   24-hour mark, or later, is not refundable.
 * - Guests are shown the deadline rounded DOWN to the minute, so what they
 *   see is never later than the real deadline.
 *
 * Bookings made under the earlier draft rule
 * ("FULL_REFUND_WITHIN_24H_OF_REQUEST", local test data only) keep the
 * deadline they were given.
 */

import { sql } from "drizzle-orm";
import { reservations } from "@/server/db/schema";

export const CANCELLATION_POLICY = {
  id: "FULL_REFUND_WITHIN_24H_OF_CONFIRMATION",
  freeCancellationHours: 24,
} as const;

/**
 * Column values for the update that confirms a booking: `confirmed_at` and
 * the free-cancellation deadline are written only if not already set, so a
 * duplicate, delayed or out-of-order confirmation can never move them. The
 * deadline is computed in the database from the same timestamp, and only
 * for bookings made under this policy.
 */
export function confirmationColumns(now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  return {
    confirmedAt: sql`COALESCE(${reservations.confirmedAt}, ${at})`,
    freeCancellationUntil: sql`CASE
      WHEN ${reservations.freeCancellationUntil} IS NOT NULL THEN ${reservations.freeCancellationUntil}
      WHEN ${reservations.cancellationPolicy} = ${CANCELLATION_POLICY.id}
        THEN COALESCE(${reservations.confirmedAt}, ${at}) + make_interval(hours => ${CANCELLATION_POLICY.freeCancellationHours})
      ELSE NULL END`,
  };
}

/** The free-cancellation deadline for a booking confirmed at `confirmedAt`. */
export function freeCancellationUntil(confirmedAt: Date): Date {
  return new Date(
    confirmedAt.getTime() +
      CANCELLATION_POLICY.freeCancellationHours * 3_600_000,
  );
}

/** True when a cancellation received at `receivedAt` gets a full refund. */
export function refundEligible(
  deadline: Date | null,
  receivedAt: Date,
): boolean {
  return deadline !== null && receivedAt.getTime() < deadline.getTime();
}

/** "2:32pm on Friday 10 October 2026", rounded down to the minute, in the property's time zone. */
export function formatDeadline(deadline: Date, timeZone: string): string {
  const floored = new Date(Math.floor(deadline.getTime() / 60_000) * 60_000);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  })
    .format(floored)
    .replace(" ", "")
    .toLowerCase();
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  })
    .format(floored)
    .replace(",", "");
  return `${time} on ${day}`;
}

/** Guest-facing one-line summary of the policy. */
export const POLICY_SUMMARY =
  "You can cancel for a full refund within 24 hours of your booking being confirmed (once your payment has gone through). After that, the booking is non-refundable.";

/** Shown before payment, when no deadline exists yet. */
export const POLICY_BEFORE_PAYMENT =
  "The 24-hour free-cancellation period starts once your payment is confirmed. After that, the booking is non-refundable.";
