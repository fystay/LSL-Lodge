"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHold } from "@/server/booking/holds";
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
