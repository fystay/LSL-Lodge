import type { ReservationStatus } from "./reservation-state";

/**
 * What the guest is told about their booking. Derived only from server-side
 * state: the reservation status, its deadline and verified payment records.
 * A browser redirect never changes it.
 */
export type GuestStatus =
  /** Request sent; the owner hasn't responded. Nothing charged. */
  | "AWAITING_APPROVAL"
  /** Owner approved; the guest must pay in full before the deadline. */
  | "APPROVED_AWAITING_PAYMENT"
  /** Stripe is still settling a payment; not confirmed yet. */
  | "PAYMENT_PROCESSING"
  /** Instant mode only: dates held while the guest pays. */
  | "HOLD_AWAITING_PAYMENT"
  /** Verified payment received; the booking stands. */
  | "CONFIRMED"
  /** Confirmed, with a scheduled balance still to pay (deposit plans). */
  | "CONFIRMED_BALANCE_DUE"
  | "DECLINED"
  | "CANCELLED"
  | "EXPIRED"
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
    case "REQUESTED":
      return lapsed ? "EXPIRED" : "AWAITING_APPROVAL";
    case "APPROVED":
      if (processing) return "PAYMENT_PROCESSING";
      return lapsed ? "EXPIRED" : "APPROVED_AWAITING_PAYMENT";
    case "PENDING_PAYMENT":
      if (processing) return "PAYMENT_PROCESSING";
      return lapsed ? "EXPIRED" : "HOLD_AWAITING_PAYMENT";
    case "CONFIRMED":
      return "CONFIRMED";
    case "PAYMENT_DUE":
      return "CONFIRMED_BALANCE_DUE";
    case "DECLINED":
      return "DECLINED";
    case "CANCELLED":
    case "REFUND_PENDING":
    case "REFUNDED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "REQUIRES_REVIEW":
      return "UNDER_REVIEW";
  }
}

/** Short label for the status, used as the page's status heading. */
export const GUEST_STATUS_LABEL: Record<GuestStatus, string> = {
  AWAITING_APPROVAL: "Request sent: awaiting the owner’s approval",
  APPROVED_AWAITING_PAYMENT: "Approved: awaiting your payment",
  PAYMENT_PROCESSING: "Payment processing",
  HOLD_AWAITING_PAYMENT: "Dates held: awaiting your payment",
  CONFIRMED: "Confirmed",
  CONFIRMED_BALANCE_DUE: "Confirmed: balance due",
  DECLINED: "Request declined",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  UNDER_REVIEW: "Being reviewed by the owner",
};
