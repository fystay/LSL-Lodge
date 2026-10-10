import { cookies } from "next/headers";
import { getBookingContext } from "@/server/booking/public";
import { findReservationForGuest } from "@/server/booking/holds";
import { releaseHoldBeforePayment } from "@/server/booking/resolution";
import { expireSessions } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import { bookingCookieName } from "../../cookie";

/**
 * Stripe's "back" link: /book/<ref>/checkout-cancelled?p=<payment id>. The
 * guest left Checkout without paying, so their unpaid hold is released and
 * they return to the details page (production's existing page) for the same
 * dates to try again. No page of its own.
 *
 * Needs the booking cookie AND the payment ID from the checkout that sent
 * them (unguessable), so a link from elsewhere can't release a guest's
 * hold. Anything already paid or being paid is left untouched.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/book/[ref]/checkout-cancelled">,
) {
  const { ref } = await params;
  const paymentId = new URL(request.url).searchParams.get("p") ?? "";
  const headers = { "Cache-Control": "no-store" };
  const fallback = new URL(`/book/${ref}`, request.url);

  const ctx = await getBookingContext();
  const token = (await cookies()).get(bookingCookieName(ref))?.value;
  if (
    !ctx ||
    !token ||
    !/^LL-[A-Z0-9]{6}$/.test(ref) ||
    !/^[0-9a-f-]{36}$/i.test(paymentId)
  )
    return Response.redirect(fallback, 303);
  const reservation = await findReservationForGuest(ctx.db, ref, token);
  if (!reservation) return Response.redirect(fallback, 303);

  const result = await releaseHoldBeforePayment(ctx.db, {
    propertyId: ctx.property.id,
    reservationId: reservation.id,
    cause: "GUEST_LEFT_CHECKOUT",
    paymentId,
  });
  if (!result.released) return Response.redirect(fallback, 303);
  const gateway = getPaymentGateway();
  if (gateway)
    await expireSessions(gateway, result.openSessions).catch(() => undefined);

  const back = new URL("/book", request.url);
  back.searchParams.set("checkIn", reservation.checkIn);
  back.searchParams.set("checkOut", reservation.checkOut);
  back.searchParams.set("guests", String(reservation.guests));
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: back.toString() },
  });
}
