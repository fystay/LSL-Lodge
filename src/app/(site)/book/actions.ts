"use server";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHold } from "@/server/booking/holds";
import { releaseHoldBeforePayment } from "@/server/booking/resolution";
import { checkoutReturnBase } from "@/server/booking/return-url";
import { startCheckout } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
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
  // Instant booking: straight on to Stripe-hosted payment. Nothing is
  // confirmed until the signed webhook (or a server-side re-fetch of the
  // session) verifies payment. If Checkout can't be opened, the hold is
  // released at once and the guest stays on this form (production's
  // existing error display) to try again.
  const gateway = getPaymentGateway();
  if (gateway) {
    const checkout = await startCheckout(ctx.db, gateway, {
      reservationId: result.reservationId,
      baseUrl: checkoutReturnBase((await headers()).get("host")),
    });
    if (checkout.ok && STRIPE_CHECKOUT.test(checkout.url))
      redirect(checkout.url as Route);
    await releaseHoldBeforePayment(ctx.db, {
      propertyId: ctx.property.id,
      reservationId: result.reservationId,
      cause: "CHECKOUT_UNAVAILABLE",
    });
    return !checkout.ok && checkout.reason === "UNAVAILABLE"
      ? {
          status: "unavailable",
          message:
            "Sorry, those dates have just become unavailable. Nothing has been reserved or charged.",
          values,
        }
      : {
          status: "error",
          message:
            "We couldn’t open the secure payment page. Nothing has been reserved or charged. Please try again in a moment.",
          values,
        };
  }
  redirect(`/book/${result.publicRef}`);
}

const STRIPE_CHECKOUT = /^https:\/\/checkout\.stripe\.com\//;
