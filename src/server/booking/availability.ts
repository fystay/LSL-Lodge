import "server-only";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { addDays, eachNight, type DateRange, type IsoDate } from "@/lib/dates";
import type { Executor } from "@/server/db/client";
import {
  externalBusyPeriods,
  externalCalendarSources,
  ownerBlocks,
  reservations,
} from "@/server/db/schema";
import { BLOCKING_STATUSES } from "./reservation-state";

/**
 * Availability = internal blocking reservations and live holds + owner blocks
 * + imported external busy periods, widened by the turnover buffer.
 *
 * This is used both for display and for the final in-transaction check. For
 * display it is advisory; only the transactional check in createHold (plus
 * the database exclusion constraint) secures dates.
 */

export type BlockSource =
  | "DIRECT_BOOKING"
  | "HOLD"
  | "OWNER_BLOCK"
  | "GOOGLE"
  | "AIRBNB_ICAL"
  | "OTHER_ICAL"
  | "CHANNEL_MANAGER";

export interface Block extends DateRange {
  id: string;
  source: BlockSource;
}

/** Loads every block that overlaps `window` (widened for turnover). */
export async function loadBlocks(
  db: Executor,
  propertyId: string,
  window: DateRange,
  turnoverNights: number,
  now: Date,
): Promise<Block[]> {
  const widened = sql`daterange(${addDays(window.start, -turnoverNights)}::date, ${addDays(window.end, turnoverNights)}::date, '[)')`;

  const [resRows, ownerRows, externalRows] = await Promise.all([
    db
      .select({
        id: reservations.id,
        start: reservations.checkIn,
        end: reservations.checkOut,
        status: reservations.status,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.propertyId, propertyId),
          inArray(reservations.status, [...BLOCKING_STATUSES]),
          sql`${reservations.stay} && ${widened}`,
          // A hold past its expiry no longer blocks, even before the sweeper runs.
          or(
            ne(reservations.status, "PENDING_PAYMENT"),
            gt(reservations.holdExpiresAt, now),
          ),
        ),
      ),
    db
      .select({
        id: ownerBlocks.id,
        start: ownerBlocks.startsOn,
        end: ownerBlocks.endsOn,
      })
      .from(ownerBlocks)
      .where(
        and(
          eq(ownerBlocks.propertyId, propertyId),
          isNull(ownerBlocks.removedAt),
          sql`${ownerBlocks.stay} && ${widened}`,
        ),
      ),
    db
      .select({
        id: externalBusyPeriods.id,
        start: externalBusyPeriods.startsOn,
        end: externalBusyPeriods.endsOn,
        provider: externalCalendarSources.provider,
      })
      .from(externalBusyPeriods)
      .innerJoin(
        externalCalendarSources,
        eq(externalBusyPeriods.sourceId, externalCalendarSources.id),
      )
      .where(
        and(
          eq(externalBusyPeriods.propertyId, propertyId),
          // External blocks stay in force until reconciled, even if the feed
          // is failing or the source has been paused.
          eq(externalBusyPeriods.status, "ACTIVE"),
          sql`${externalBusyPeriods.stay} && ${widened}`,
        ),
      ),
  ]);

  return [
    ...resRows.map((r) => ({
      id: r.id,
      start: r.start as IsoDate,
      end: r.end as IsoDate,
      source: (r.status === "PENDING_PAYMENT"
        ? "HOLD"
        : "DIRECT_BOOKING") as BlockSource,
    })),
    ...ownerRows.map((r) => ({
      id: r.id,
      start: r.start as IsoDate,
      end: r.end as IsoDate,
      source: "OWNER_BLOCK" as const,
    })),
    ...externalRows.map((r) => ({
      id: r.id,
      start: r.start as IsoDate,
      end: r.end as IsoDate,
      source: (r.provider === "GOOGLE" ? "GOOGLE" : r.provider) as BlockSource,
    })),
  ];
}

/**
 * Blocks that make `stay` unavailable. With a turnover buffer of N nights, a
 * new stay may not start within N nights after another ends, nor end within
 * N nights before another starts.
 */
export function conflictingBlocks(
  blocks: readonly Block[],
  stay: DateRange,
  turnoverNights: number,
): Block[] {
  return blocks.filter(
    (b) =>
      stay.start < addDays(b.end, turnoverNights) &&
      addDays(b.start, -turnoverNights) < stay.end,
  );
}

export type NightStatus = "available" | "booked" | "turnover";

/** Per-night status for calendars. Labels never reveal which source booked a night. */
export function nightStatuses(
  blocks: readonly Block[],
  window: DateRange,
  turnoverNights: number,
): Map<IsoDate, NightStatus> {
  const result = new Map<IsoDate, NightStatus>();
  for (const night of eachNight(window)) result.set(night, "available");
  for (const block of blocks) {
    for (const night of eachNight({
      start: addDays(block.start, -turnoverNights),
      end: addDays(block.end, turnoverNights),
    })) {
      if (!result.has(night)) continue;
      const booked = night >= block.start && night < block.end;
      if (booked) result.set(night, "booked");
      else if (result.get(night) === "available") result.set(night, "turnover");
    }
  }
  return result;
}
