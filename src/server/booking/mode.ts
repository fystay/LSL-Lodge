import "server-only";

/**
 * Booking modes.
 *
 * - REQUEST (initial, owner-chosen): the guest submits a request, the owner
 *   approves or declines it, and only then is the guest asked to pay in full.
 *   Nothing is charged before approval.
 * - INSTANT: the guest pays straight away and the booking confirms on
 *   verified payment. Built and tested, but refused at runtime unless
 *   INSTANT_BOOKING_APPROVED is exactly "true", which needs the owner's
 *   explicit sign-off of the instant-booking policy and payment sequence (see
 *   docs/PLAN.md §8). A property set to INSTANT without that approval takes
 *   no bookings at all rather than silently falling back.
 */

export type BookingMode = "REQUEST" | "INSTANT";

export function instantBookingApproved(): boolean {
  return process.env.INSTANT_BOOKING_APPROVED === "true";
}

/** The mode new bookings use, or null if the configured mode isn't allowed. */
export function effectiveBookingMode(
  configured: BookingMode,
): BookingMode | null {
  if (configured === "INSTANT" && !instantBookingApproved()) return null;
  return configured;
}
