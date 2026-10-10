/**
 * The host's cancellation policy (confirmed by the owner, October 2026):
 *
 *   Guests may cancel within 24 hours of submitting their booking for a full
 *   refund. Cancellations after that are non-refundable.
 *
 * Rules, applied on the server only:
 * - The window starts at `requestedAt`: the moment the server accepted the
 *   booking (when the dates were first held). It does not restart when
 *   payment completes or when the guest views the booking.
 * - `freeCancellationUntil = requestedAt + 24 hours`, stored on the booking
 *   when it is created and immutable afterwards (database trigger).
 * - Boundary: a cancellation is eligible only if the server receives it
 *   STRICTLY BEFORE `freeCancellationUntil`. One received exactly at the
 *   24-hour mark, or later, is not refundable.
 * - Guests are shown the deadline rounded DOWN to the minute ("before
 *   14:32"), so what they see is never later than the real deadline.
 */

export const CANCELLATION_POLICY = {
  id: "FULL_REFUND_WITHIN_24H_OF_REQUEST",
  freeCancellationHours: 24,
} as const;

export function freeCancellationUntil(requestedAt: Date): Date {
  return new Date(
    requestedAt.getTime() +
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
  "You can cancel for a full refund within 24 hours of making your booking. After that, the booking is non-refundable.";
