import type { ReservationStatus } from "./reservation-state";

/**
 * What the guest is told about their booking. Derived only from server-side
 * state: the reservation status, its hold expiry and verified payment
 * records. A browser redirect never changes it.
 */
export type GuestStatus =
  /** Dates held while the guest pays. Not booked yet. */
  | "HOLD_AWAITING_PAYMENT"
  /** Stripe is still settling a payment; not confirmed yet. */
  | "PAYMENT_PROCESSING"
  /** Verified payment received; the booking stands. */
  | "CONFIRMED"
  /** Confirmed, with a scheduled balance still to pay (deposit plans). */
  | "CONFIRMED_BALANCE_DUE"
  /** Cancelled; no refund was due, or none has been started. */
  | "CANCELLED"
  /** Cancelled; a refund has been started but Stripe hasn't confirmed it. */
  | "CANCELLED_REFUND_IN_PROGRESS"
  /** Cancelled; Stripe has confirmed the refund. */
  | "CANCELLED_REFUNDED"
  | "EXPIRED"
  /** Legacy request-mode decline. */
  | "DECLINED"
  /** Something needs the owner's attention (e.g. a late payment). */
  | "UNDER_REVIEW";

export interface GuestStatusInput {
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  /** Statuses of this reservation's charge records. */
  paymentStatuses: readonly string[];
}

export function guestStatus(r: GuestStatusInput, now: Date): GuestStatus {
  const lapsed = r.holdExpiresAt !== null && r.holdExpiresAt <= now;
  const processing = r.paymentStatuses.includes("PROCESSING");
  switch (r.status) {
    case "PENDING_PAYMENT":
    case "APPROVED": // legacy: an approved request awaiting payment
      if (processing) return "PAYMENT_PROCESSING";
      return lapsed ? "EXPIRED" : "HOLD_AWAITING_PAYMENT";
    case "REQUESTED": // legacy: an unanswered request
      return lapsed ? "EXPIRED" : "UNDER_REVIEW";
    case "CONFIRMED":
      return "CONFIRMED";
    case "PAYMENT_DUE":
      return "CONFIRMED_BALANCE_DUE";
    case "DECLINED":
      return "DECLINED";
    case "CANCELLED":
      return "CANCELLED";
    case "REFUND_PENDING":
      return "CANCELLED_REFUND_IN_PROGRESS";
    case "REFUNDED":
      return "CANCELLED_REFUNDED";
    case "EXPIRED":
      return "EXPIRED";
    case "REQUIRES_REVIEW":
      return "UNDER_REVIEW";
  }
}

/** Short label for the status, used as the page's status heading. */
export const GUEST_STATUS_LABEL: Record<GuestStatus, string> = {
  HOLD_AWAITING_PAYMENT: "Dates held: awaiting your payment",
  PAYMENT_PROCESSING: "Payment processing",
  CONFIRMED: "Confirmed",
  CONFIRMED_BALANCE_DUE: "Confirmed: balance due",
  CANCELLED: "Cancelled",
  CANCELLED_REFUND_IN_PROGRESS: "Cancelled: refund in progress",
  CANCELLED_REFUNDED: "Cancelled and refunded",
  EXPIRED: "Expired",
  DECLINED: "Request declined",
  UNDER_REVIEW: "Being reviewed by the owner",
};
