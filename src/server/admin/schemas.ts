import { z } from "zod";
import { isIsoDate, type IsoDate } from "@/lib/dates";

/** Converts a pounds amount typed by the owner ("150", "150.5", "£1,200.00") to pence. */
export function parsePounds(input: string): number | null {
  const cleaned = input.trim().replace(/^£/, "").replace(/,/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export const penceToPounds = (minor: number) => (minor / 100).toFixed(2);

const date = z
  .string()
  .trim()
  .refine(isIsoDate, "Enter a valid date.")
  .transform((v) => v as IsoDate);

const pounds = (label: string) =>
  z.string().transform((v, ctx) => {
    const pence = parsePounds(v);
    if (pence === null) {
      ctx.addIssue({
        code: "custom",
        message: `${label}: enter an amount in pounds, e.g. 150 or 150.50.`,
      });
      return z.NEVER;
    }
    return pence;
  });

const optionalPounds = (label: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v.trim() === "") return null;
      const pence = parsePounds(v);
      if (pence === null) {
        ctx.addIssue({
          code: "custom",
          message: `${label}: enter an amount in pounds.`,
        });
        return z.NEVER;
      }
      return pence;
    });

const optionalInt = (min: number, max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v.trim() === "") return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({
          code: "custom",
          message: `${label} must be a whole number from ${min} to ${max}.`,
        });
        return z.NEVER;
      }
      return n;
    });

const percent = (label: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v.trim() === "") return null;
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) || Number(v) > 100) {
        ctx.addIssue({
          code: "custom",
          message: `${label} must be a percentage from 0 to 100.`,
        });
        return z.NEVER;
      }
      return Math.round(Number(v) * 100); // basis points
    });

export const ownerBlockSchema = z
  .object({
    startsOn: date,
    endsOn: date,
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((v) => v || null),
  })
  .refine((v) => v.endsOn > v.startsOn, {
    message: "The end date must be after the start date.",
    path: ["endsOn"],
  });

export const rateRuleSchema = z
  .object({
    name: z.string().trim().min(1, "Give the rate a name.").max(100),
    startsOn: date,
    endsOn: date,
    nightly: pounds("Nightly rate"),
    weekendNightly: optionalPounds("Weekend rate"),
    minNights: optionalInt(1, 60, "Minimum nights"),
    priority: optionalInt(0, 100, "Priority").transform((v) => v ?? 0),
    arrivalDays: z
      .array(z.coerce.number().int().min(1).max(7))
      .optional()
      .transform((v) =>
        v && v.length > 0 && v.length < 7 ? [...new Set(v)].sort() : null,
      ),
  })
  .refine((v) => v.endsOn > v.startsOn, {
    message: "The end date must be after the start date.",
    path: ["endsOn"],
  });

export const feeRuleSchema = z
  .object({
    name: z.string().trim().min(1, "Give the fee a name.").max(100),
    kind: z.enum([
      "PER_STAY",
      "PER_NIGHT",
      "PER_GUEST_PER_NIGHT",
      "PERCENT_OF_ACCOMMODATION",
    ]),
    amount: optionalPounds("Amount"),
    percent: percent("Percentage"),
    appliesAboveGuests: optionalInt(0, 50, "Guests included"),
    taxTreatment: z.enum([
      "INCLUDED",
      "EXCLUDED",
      "NOT_APPLICABLE",
      "UNCONFIRMED",
    ]),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "PERCENT_OF_ACCOMMODATION" && v.percent === null)
      ctx.addIssue({
        code: "custom",
        message: "Enter the percentage.",
        path: ["percent"],
      });
    if (v.kind !== "PERCENT_OF_ACCOMMODATION" && v.amount === null)
      ctx.addIssue({
        code: "custom",
        message: "Enter the amount.",
        path: ["amount"],
      });
  });

export const paymentPolicySchema = z
  .object({
    mode: z.enum(["FULL", "DEPOSIT"]),
    depositPercent: percent("Deposit percentage"),
    depositFixed: optionalPounds("Fixed deposit"),
    minimumDeposit: optionalPounds("Minimum deposit"),
    balanceDueDays: optionalInt(0, 365, "Balance due (days before arrival)"),
    fullPaymentWithinDays: optionalInt(0, 365, "Full payment window"),
  })
  .superRefine((v, ctx) => {
    if (v.mode !== "DEPOSIT") return;
    if ((v.depositPercent === null) === (v.depositFixed === null))
      ctx.addIssue({
        code: "custom",
        message: "Enter either a deposit percentage or a fixed deposit.",
        path: ["depositPercent"],
      });
    if (v.depositPercent === 0)
      ctx.addIssue({
        code: "custom",
        message: "A deposit percentage must be above 0.",
        path: ["depositPercent"],
      });
    if (v.balanceDueDays === null)
      ctx.addIssue({
        code: "custom",
        message: "Enter when the balance is due.",
        path: ["balanceDueDays"],
      });
  });

const time = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine(
    (v) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    "Use 24-hour time, e.g. 16:00.",
  );

export const propertySettingsSchema = z.object({
  maxGuests: optionalInt(1, 50, "Maximum guests").refine(
    (v) => v !== null,
    "Enter the maximum guests.",
  ),
  defaultMinNights: optionalInt(1, 60, "Minimum stay").refine(
    (v) => v !== null,
    "Enter the minimum stay.",
  ),
  turnoverNights: optionalInt(0, 14, "Changeover nights").transform(
    (v) => v ?? 0,
  ),
  bookingHorizonDays: optionalInt(30, 730, "Booking horizon").refine(
    (v) => v !== null,
    "Enter the booking horizon.",
  ),
  checkInTime: time,
  checkOutTime: time,
  bookingsEnabled: z
    .string()
    .optional()
    .transform((v) => v === "on"),
});

/** First error message per field, for form display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}
