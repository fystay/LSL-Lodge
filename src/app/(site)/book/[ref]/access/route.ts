import { cookies } from "next/headers";
import { getBookingContext } from "@/server/booking/public";
import { findReservationForGuest } from "@/server/booking/holds";
import {
  GUEST_LINK_DAYS,
  looksLikeGuestLink,
} from "@/server/booking/guest-link";
import { bookingCookieName } from "../../cookie";

/**
 * Entry point for links in booking emails: /book/<ref>/access?t=<signed link>.
 * A valid link is moved into the booking's httpOnly cookie and the guest is
 * redirected to the clean booking URL, so the token doesn't stay in the
 * address bar, history or referrers. An invalid link reveals nothing.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/book/[ref]/access">,
) {
  const { ref } = await params;
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const target = new URL(`/book/${ref}`, request.url);
  const headers = {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };

  const ctx = await getBookingContext();
  const valid =
    ctx &&
    /^LL-[A-Z0-9]{6}$/.test(ref) &&
    looksLikeGuestLink(token) &&
    (await findReservationForGuest(ctx.db, ref, token));
  if (!valid)
    return new Response("This link is invalid or has expired.", {
      status: 404,
      headers,
    });

  (await cookies()).set(bookingCookieName(ref), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/book/${ref}`,
    maxAge: GUEST_LINK_DAYS * 86_400,
  });
  return Response.redirect(target, 303);
}
