/**
 * Reservation lifecycle. This table is the single source of truth for which
 * status changes are legal; the database enforces the same table with a
 * trigger (drizzle/0002_host_approval_workflow.sql), and an integration test
 * checks the two agree.
 *
 * Payment state is tracked separately (payments / payment_schedule_items).
 * These statuses describe the stay, not the money.
 *
 * Host-approval journey (the initial mode):
 *   REQUESTED → APPROVED → CONFIRMED (verified full payment)
 *             ↘ DECLINED   ↘ EXPIRED (guest didn't pay in time)
 *             ↘ EXPIRED (owner didn't respond in time)
 * Instant journey (built, disabled until the owner approves it):
 *   PENDING_PAYMENT → CONFIRMED / PAYMENT_DUE / EXPIRED
 */

export const RESERVATION_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "DECLINED",
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
  // A guest's request, holding the dates until the owner responds. Nothing
  // has been charged.
  REQUESTED: [
    "APPROVED",
    "DECLINED",
    "EXPIRED",
    "CANCELLED",
    "REQUIRES_REVIEW",
  ],
  // The owner accepted; the dates are held until the guest pays in full.
  // Only verified payment moves it on to CONFIRMED.
  APPROVED: [
    "CONFIRMED",
    "PAYMENT_DUE",
    "EXPIRED",
    "CANCELLED",
    "REQUIRES_REVIEW",
  ],
  // The owner said no. Nothing was charged, so nothing follows.
  DECLINED: [],
  // Instant mode: a hold awaiting verified payment.
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
  // Payment arrived after the request or hold expired: route to review, never
  // auto-confirm. (If the dates have since been taken, the exclusion
  // constraint rejects this move and the payment is flagged for refund.)
  EXPIRED: ["REQUIRES_REVIEW"],
  // A refund owed under the cancellation policy may follow cancellation.
  CANCELLED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED", "REQUIRES_REVIEW"],
  // Reopened only if Stripe later reports a confirmed refund as failed: the
  // guest is owed the money again.
  REFUNDED: ["REFUND_PENDING"],
  // Owner resolves conflicts and exceptional payment/calendar states. Moving
  // to CONFIRMED additionally requires a recorded, verified payment
  // (enforced in confirmReviewedBooking, src/server/booking/resolution.ts).
  REQUIRES_REVIEW: [
    "APPROVED",
    "DECLINED",
    "CONFIRMED",
    "PAYMENT_DUE",
    "CANCELLED",
    "REFUND_PENDING",
  ],
};

/** Statuses that occupy the calendar. Everything else frees the dates. */
export const BLOCKING_STATUSES: readonly ReservationStatus[] = [
  "REQUESTED",
  "APPROVED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "REQUIRES_REVIEW",
];

/**
 * Blocking statuses that only hold dates until `holdExpiresAt`. Past that
 * moment they stop blocking, even before the sweeper marks them EXPIRED.
 */
export const EXPIRING_STATUSES: readonly ReservationStatus[] = [
  "REQUESTED",
  "APPROVED",
  "PENDING_PAYMENT",
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
