import { z } from "zod";
import { addDays, daysBetween, isIsoDate, nights, type IsoDate } from "./dates";

/**
 * Validation for a date-and-guests search. Used by the server to validate
 * query strings; the client form mirrors the simple bounds for convenience
 * but is never trusted. Availability itself is decided on the server.
 */

export interface StaySearchLimits {
  maxGuests: number;
  minNights: number;
  maxNights: number;
  horizonDays: number;
}

export interface StaySearch {
  checkIn: IsoDate;
  checkOut: IsoDate;
  guests: number;
  nights: number;
}

export type SearchField = "checkIn" | "checkOut" | "guests";

export type StaySearchResult =
  | { status: "empty" }
  | {
      status: "invalid";
      errors: { field: SearchField; message: string }[];
      input: Record<SearchField, string>;
    }
  | { status: "valid"; search: StaySearch };

const raw = z.object({
  checkIn: z.string().trim().max(20).default(""),
  checkOut: z.string().trim().max(20).default(""),
  guests: z.string().trim().max(3).default(""),
});

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

export function validateStaySearch(
  params: Record<string, string | string[] | undefined>,
  limits: StaySearchLimits,
  today: IsoDate,
): StaySearchResult {
  const input = raw.parse({
    checkIn: first(params.checkIn) ?? "",
    checkOut: first(params.checkOut) ?? "",
    guests: first(params.guests) ?? "",
  });
  if (!input.checkIn && !input.checkOut && !input.guests)
    return { status: "empty" };

  const errors: { field: SearchField; message: string }[] = [];
  const checkIn = isIsoDate(input.checkIn) ? input.checkIn : undefined;
  const checkOut = isIsoDate(input.checkOut) ? input.checkOut : undefined;

  if (!checkIn) {
    errors.push({ field: "checkIn", message: "Enter a check-in date." });
  } else if (checkIn < today) {
    errors.push({
      field: "checkIn",
      message: "Check-in can’t be in the past.",
    });
  } else if (daysBetween(today, checkIn) > limits.horizonDays) {
    errors.push({
      field: "checkIn",
      message: `Dates can be searched up to ${addDays(today, limits.horizonDays)}.`,
    });
  }

  if (!checkOut) {
    errors.push({ field: "checkOut", message: "Enter a check-out date." });
  } else if (checkIn && checkOut <= checkIn) {
    errors.push({
      field: "checkOut",
      message: "Check-out must be after check-in.",
    });
  } else if (checkIn) {
    const n = nights({ start: checkIn, end: checkOut });
    if (n < limits.minNights) {
      errors.push({
        field: "checkOut",
        message: `The minimum stay is ${limits.minNights} night${limits.minNights === 1 ? "" : "s"}.`,
      });
    } else if (n > limits.maxNights) {
      errors.push({
        field: "checkOut",
        message: `Stays of more than ${limits.maxNights} nights: please contact us.`,
      });
    }
  }

  const guests = /^\d+$/.test(input.guests) ? Number(input.guests) : NaN;
  if (!Number.isInteger(guests) || guests < 1) {
    errors.push({ field: "guests", message: "Choose the number of guests." });
  } else if (guests > limits.maxGuests) {
    errors.push({
      field: "guests",
      message: `The lodge sleeps up to ${limits.maxGuests}.`,
    });
  }

  if (errors.length > 0 || !checkIn || !checkOut)
    return { status: "invalid", errors, input };
  return {
    status: "valid",
    search: {
      checkIn,
      checkOut,
      guests,
      nights: nights({ start: checkIn, end: checkOut }),
    },
  };
}
