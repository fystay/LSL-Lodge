import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, notInArray, or } from "drizzle-orm";
import { addDays, type IsoDate } from "@/lib/dates";
import type { Executor } from "@/server/db/client";
import { ownerBlocks, reservations } from "@/server/db/schema";
import {
  BLOCKING_STATUSES,
  EXPIRING_STATUSES,
} from "@/server/booking/reservation-state";

/**
 * The website's own availability as an iCalendar feed, for Airbnb (or any
 * calendar) to subscribe to: /calendar/<token>.ics.
 *
 * - Contains website reservations and live requests/holds (they hold dates)
 *   plus owner blocks. Never re-exports periods imported from Airbnb or
 *   Google, so the two calendars can't echo each other in a loop.
 * - Events say only "Not available": no names, prices or references.
 * - The token is an HMAC of the property ID under CALENDAR_EXPORT_SECRET;
 *   rotating the secret revokes the old URL. The URL is a secret: give it to
 *   Airbnb only.
 * - Airbnb reads this on its own schedule, so new bookings reach Airbnb with
 *   a delay we don't control.
 */

export function calendarExportSecret(): string | null {
  const secret = process.env.CALENDAR_EXPORT_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function exportToken(secret: string, propertyId: string): string {
  return createHmac("sha256", secret)
    .update(`calendar-export|${propertyId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function verifyExportToken(
  secret: string,
  propertyId: string,
  token: string,
): boolean {
  const expected = Buffer.from(exportToken(secret, propertyId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const compactDate = (d: string) => d.replaceAll("-", "");
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export async function buildExportFeed(
  db: Executor,
  propertyId: string,
  today: IsoDate,
  now: Date,
): Promise<string> {
  // A little history keeps recently finished stays visible to subscribers.
  const from = addDays(today, -30);
  const [stays, blocks] = await Promise.all([
    db
      .select({
        id: reservations.id,
        start: reservations.checkIn,
        end: reservations.checkOut,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.propertyId, propertyId),
          inArray(reservations.status, [...BLOCKING_STATUSES]),
          gte(reservations.checkOut, from),
          or(
            notInArray(reservations.status, [...EXPIRING_STATUSES]),
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
          gte(ownerBlocks.endsOn, from),
        ),
      ),
  ]);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lodge on the Lake//Direct bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const events = [
    ...stays.map((s) => ({ ...s, kind: "booking" })),
    ...blocks.map((b) => ({ ...b, kind: "block" })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.kind}-${e.id}@lodge-on-the-lake`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compactDate(e.start)}`,
      `DTEND;VALUE=DATE:${compactDate(e.end)}`,
      "SUMMARY:Not available",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
