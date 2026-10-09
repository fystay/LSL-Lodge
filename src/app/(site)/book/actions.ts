"use server";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHold, findReservationForGuest } from "@/server/booking/holds";
import { guestCancel } from "@/server/booking/resolution";
import { expireSessions, startCheckout } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import { siteUrl } from "@/lib/site";
import {
  clientIp,
  consumeRateLimit,
  LIMITS,
} from "@/server/security/rate-limit";
import { getBookingContext } from "@/server/booking/public";
import {
  holdRequestSchema,
  type GuestField,
  type HoldFormState,
} from "@/server/booking/guest-details";
import { describeQuoteError } from "@/server/pricing/quote";
import { bookingCookieName } from "./cookie";

export async function placeHold(
  _previous: HoldFormState,
  form: FormData,
): Promise<HoldFormState> {
  const values = {
    name: String(form.get("name") ?? "").slice(0, 200),
    email: String(form.get("email") ?? "").slice(0, 300),
    phone: String(form.get("phone") ?? "").slice(0, 60),
  };
  const parsed = holdRequestSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const errors: Partial<Record<GuestField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (
        field === "name" ||
        field === "email" ||
        field === "phone" ||
        field === "acceptTerms"
      ) {
        errors[field] ??= issue.message;
      } else {
        return {
          status: "error",
          message: "Your search has changed. Please search again.",
          values,
        };
      }
    }
    return { status: "invalid", errors, values };
  }

  const ctx = await getBookingContext();
  if (!ctx)
    return {
      status: "error",
      message: "Online booking isn’t available right now.",
      values,
    };

  const data = parsed.data;
  // Requests hold dates and send email, so they are limited per visitor and
  // per guest email address.
  const ip = clientIp(await headers());
  const allowed =
    (await consumeRateLimit(ctx.db, LIMITS.requestPerIp, ip)) &&
    (await consumeRateLimit(ctx.db, LIMITS.requestPerEmail, data.email));
  if (!allowed)
    return {
      status: "error",
      message:
        "You’ve sent several requests recently. Please try again later, or contact us directly.",
      values,
    };
  const result = await createHold(ctx.db, {
    propertyId: ctx.property.id,
    checkIn: data.checkIn,
    checkOut: data.checkOut,
    guests: data.guests,
    guest: { name: data.name, email: data.email, phone: data.phone },
    idempotencyKey: data.idempotencyKey,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "UNAVAILABLE":
        return {
          status: "unavailable",
          message:
            "Sorry, those dates have just become unavailable. Nothing has been reserved or charged.",
          values,
        };
      case "QUOTE":
        return {
          status: "error",
          message: describeQuoteError(result.error),
          values,
        };
      default:
        return {
          status: "error",
          message: "Online booking isn’t available right now.",
          values,
        };
    }
  }

  const jar = await cookies();
  jar.set(bookingCookieName(result.publicRef), result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/book/${result.publicRef}`,
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(`/book/${result.publicRef}`);
}

const REF = /^LL-[A-Z0-9]{6}$/;
const STRIPE_CHECKOUT = /^https:\/\/checkout\.stripe\.com\//;

/**
 * Sends an approved guest to Stripe-hosted Checkout for the amount due.
 * Who the guest is comes from their booking cookie, never the form; the
 * amount comes from the stored schedule, never the client.
 */
export async function startPaymentAction(form: FormData) {
  const ref = String(form.get("ref") ?? "");
  if (!REF.test(ref)) redirect("/availability");
  // Annotated so TypeScript knows it never returns.
  const back: (status: string) => never = (status) =>
    redirect(`/book/${ref}?payment=${status}`);

  const token = (await cookies()).get(bookingCookieName(ref))?.value;
  const ctx = await getBookingContext();
  if (!ctx || !token) back("unavailable");
  const reservation = await findReservationForGuest(ctx.db, ref, token);
  if (!reservation) back("unavailable");
  const gateway = getPaymentGateway();
  if (!gateway) back("unavailable");
  if (!(await consumeRateLimit(ctx.db, LIMITS.paymentPerBooking, ref)))
    back("error");

  const result = await startCheckout(ctx.db, gateway, {
    reservationId: reservation.id,
    baseUrl: siteUrl,
  });
  if (!result.ok)
    back(
      result.reason === "PROVIDER_ERROR"
        ? "error"
        : result.reason === "UNAVAILABLE"
          ? "conflict"
          : "unavailable",
    );
  // Only ever redirect to Stripe's own hosted page.
  if (!STRIPE_CHECKOUT.test(result.url)) back("error");
  // External (Stripe) URL: typed routes only cover our own paths.
  redirect(result.url as Route);
}

/**
 * The guest withdraws an unpaid request/approval, or asks the owner to
 * cancel a paid booking. Identity comes from the booking cookie only.
 */
export async function guestCancelAction(form: FormData) {
  const ref = String(form.get("ref") ?? "");
  if (!REF.test(ref)) redirect("/availability");
  const back: (status: string) => never = (status) =>
    redirect(`/book/${ref}?cancel=${status}`);
  if (form.get("confirm") !== "yes") back("unconfirmed");

  const token = (await cookies()).get(bookingCookieName(ref))?.value;
  const ctx = await getBookingContext();
  if (!ctx || !token) back("error");
  const reservation = await findReservationForGuest(ctx.db, ref, token);
  if (!reservation) back("error");
  if (!(await consumeRateLimit(ctx.db, LIMITS.paymentPerBooking, ref)))
    back("error");

  const result = await guestCancel(ctx.db, {
    propertyId: ctx.property.id,
    reservationId: reservation.id,
  });
  if (!result.ok) back("error");
  if (result.outcome === "WITHDRAWN") {
    const gateway = getPaymentGateway();
    if (gateway) await expireSessions(gateway, result.openSessions);
  }
  back(result.outcome === "WITHDRAWN" ? "withdrawn" : "requested");
}
