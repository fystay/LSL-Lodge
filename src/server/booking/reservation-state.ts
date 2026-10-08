/**
 * Reservation lifecycle. This table is the single source of truth for which
 * status changes are legal; the database enforces the same table with a
 * trigger (drizzle/0001_overlap_protection.sql), and an integration test
 * checks the two agree.
 *
 * Payment state is tracked separately (payments / payment_schedule_items).
 * These statuses describe the stay, not the money.
 */

export const RESERVATION_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "CANCELLED",
  "EXPIRED",
  "REFUND_PENDING",
  "REFUNDED",
  "REQUIRES_REVIEW",
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  // A hold awaiting verified payment.
  PENDING_PAYMENT: [
    "CONFIRMED",
    "PAYMENT_DUE",
    "EXPIRED",
    "CANCELLED",
    "REQUIRES_REVIEW",
  ],
  // Fully paid (or nothing further due).
  CONFIRMED: ["CANCELLED", "REFUND_PENDING", "REQUIRES_REVIEW"],
  // Deposit verified, balance outstanding. Paying the balance confirms it.
  PAYMENT_DUE: ["CONFIRMED", "CANCELLED", "REFUND_PENDING", "REQUIRES_REVIEW"],
  // Payment arrived after the hold expired: route to review, never auto-confirm.
  // (If the dates have since been taken, the exclusion constraint rejects this
  // move and the payment is flagged for refund instead.)
  EXPIRED: ["REQUIRES_REVIEW"],
  // A refund owed under the cancellation policy may follow cancellation.
  CANCELLED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED", "REQUIRES_REVIEW"],
  REFUNDED: [],
  // Owner resolves conflicts and exceptional payment/calendar states.
  REQUIRES_REVIEW: ["CONFIRMED", "PAYMENT_DUE", "CANCELLED", "REFUND_PENDING"],
};

/** Statuses that occupy the calendar. Everything else frees the dates. */
export const BLOCKING_STATUSES: readonly ReservationStatus[] = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "REQUIRES_REVIEW",
];

export function canTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(`Reservation cannot move from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
