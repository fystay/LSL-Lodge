import { z } from "zod";

export const enquirySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your name.")
    .max(120, "Name is too long."),
  email: z.string().trim().max(254).email("Enter a valid email address."),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a little more (at least 10 characters).")
    .max(4000, "Message is too long (4,000 characters maximum)."),
  // Honeypot: real visitors never see or fill this field.
  website: z.string().max(0).optional(),
});

export type EnquiryField = "name" | "email" | "message";

export type EnquiryState =
  | { status: "idle" }
  | {
      status: "invalid" | "unavailable" | "error";
      errors?: Partial<Record<EnquiryField, string>>;
      values: Record<EnquiryField, string>;
    }
  | { status: "sent" };

export function readEnquiry(form: FormData) {
  const values: Record<EnquiryField, string> = {
    name: String(form.get("name") ?? "").slice(0, 200),
    email: String(form.get("email") ?? "").slice(0, 300),
    message: String(form.get("message") ?? "").slice(0, 5000),
  };
  const result = enquirySchema.safeParse({
    ...values,
    website: String(form.get("website") ?? ""),
  });
  return { values, result };
}
