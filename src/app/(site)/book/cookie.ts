/** Per-booking cookie holding the guest's access token, scoped to that booking's page. */
export const bookingCookieName = (publicRef: string) =>
  `lodge_booking_${publicRef.replace(/[^A-Z0-9-]/g, "")}`;
