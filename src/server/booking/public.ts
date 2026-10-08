import "server-only";
import { addDays, type IsoDate } from "@/lib/dates";
import { db, isDatabaseConfigured, type Database } from "@/server/db/client";
import { calculateQuote, type QuoteResult } from "@/server/pricing/quote";
import {
  loadPricingInputs,
  loadPropertyBySlug,
  type PropertyRow,
} from "@/server/pricing/load";
import {
  conflictingBlocks,
  loadBlocks,
  nightStatuses,
  type NightStatus,
} from "./availability";

/**
 * Read-side booking helpers for public pages. Everything here is advisory:
 * dates are only secured by createHold's transaction.
 */

export const PROPERTY_SLUG = process.env.PROPERTY_SLUG ?? "lodge-on-the-lake";

/**
 * The online booking flow is shown only when explicitly enabled, a database
 * is configured, and never in Vercel production before payments exist
 * (Phase 3). The property must also have `bookings_enabled` set.
 */
export function bookingFlowEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  return process.env.BOOKING_PREVIEW === "true" && isDatabaseConfigured();
}

export interface BookingContext {
  db: Database;
  property: PropertyRow;
}

export async function getBookingContext(): Promise<BookingContext | null> {
  if (!bookingFlowEnabled()) return null;
  const database = db();
  const property = await loadPropertyBySlug(database, PROPERTY_SLUG);
  if (!property || !property.bookingsEnabled) return null;
  return { db: database, property };
}

export interface StayCheck {
  available: boolean;
  quote: QuoteResult | null;
}

export async function checkStay(
  ctx: BookingContext,
  stay: { checkIn: IsoDate; checkOut: IsoDate; guests: number },
  today: IsoDate,
  now: Date,
): Promise<StayCheck> {
  const { property } = ctx;
  const range = { start: stay.checkIn, end: stay.checkOut };
  const [blocks, pricing] = await Promise.all([
    loadBlocks(ctx.db, property.id, range, property.turnoverNights, now),
    loadPricingInputs(ctx.db, property),
  ]);
  const available =
    conflictingBlocks(blocks, range, property.turnoverNights).length === 0;
  if (!pricing.policy) return { available, quote: null };
  const quote = calculateQuote(
    {
      currency: property.currency,
      maxGuests: property.maxGuests,
      defaultMinNights: property.defaultMinNights,
    },
    pricing.rates,
    pricing.fees,
    pricing.policy,
    { ...stay, today },
  );
  return { available, quote };
}

export async function calendarStatuses(
  ctx: BookingContext,
  from: IsoDate,
  days: number,
  now: Date,
): Promise<Map<IsoDate, NightStatus>> {
  const window = { start: from, end: addDays(from, days) };
  const blocks = await loadBlocks(
    ctx.db,
    ctx.property.id,
    window,
    ctx.property.turnoverNights,
    now,
  );
  return nightStatuses(blocks, window, ctx.property.turnoverNights);
}
