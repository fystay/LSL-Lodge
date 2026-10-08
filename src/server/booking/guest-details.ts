import { z } from "zod";
import { isIsoDate, type IsoDate } from "@/lib/dates";

const isoDate = z
  .string()
  .refine(isIsoDate, "Invalid date")
  .transform((v) => v as IsoDate);

/** Booking form payload. Prices and availability are never taken from the client. */
export const holdRequestSchema = z.object({
  checkIn: isoDate,
  checkOut: isoDate,
  guests: z.coerce.number().int().min(1).max(50),
  idempotencyKey: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Enter the lead guest’s name.")
    .max(120, "Name is too long."),
  email: z.string().trim().max(254).email("Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .max(30, "Phone number is too long.")
    .regex(/^[0-9+()\-\s]*$/, "Enter a valid phone number.")
    .optional()
    .transform((v) => (v ? v : null)),
  acceptTerms: z.literal("on", {
    message: "Please confirm you have read the booking terms.",
  }),
});

export type GuestField = "name" | "email" | "phone" | "acceptTerms";

export type HoldFormState =
  | { status: "idle" }
  | {
      status: "invalid" | "unavailable" | "error";
      message?: string;
      errors?: Partial<Record<GuestField, string>>;
      values: { name: string; email: string; phone: string };
    };
