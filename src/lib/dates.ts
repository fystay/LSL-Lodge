/**
 * Calendar-date utilities for stays.
 *
 * Stay dates are *local property calendar dates* (no time, no zone), written
 * as ISO `YYYY-MM-DD` strings. A stay is the half-open range
 * [checkIn, checkOut): the check-in night is included, the check-out date is
 * not, so one guest can leave on the day the next arrives.
 *
 * Arithmetic is done on UTC midnights, which have no daylight-saving
 * transitions, so adding a day always moves exactly one calendar date. Only
 * `todayInTimeZone` touches real instants, and it converts through Intl with
 * the property's IANA time zone.
 */

declare const isoDateBrand: unique symbol;
export type IsoDate = string & { readonly [isoDateBrand]: true };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export function parseIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) throw new RangeError(`Invalid calendar date`);
  return value;
}

function toUtcMs(date: IsoDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new RangeError("days must be an integer");
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DateRange {
  /** Inclusive. */
  start: IsoDate;
  /** Exclusive. */
  end: IsoDate;
}

export function nights(range: DateRange): number {
  return daysBetween(range.start, range.end);
}

/** Half-open overlap: ranges that merely touch do not overlap. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Each night of the stay, as the date the night begins. */
export function eachNight(range: DateRange): IsoDate[] {
  const result: IsoDate[] = [];
  for (let d = range.start; d < range.end; d = addDays(d, 1)) result.push(d);
  return result;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const day = new Date(toUtcMs(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The calendar date at `instant` in the given IANA time zone. */
export function todayInTimeZone(
  timeZone: string,
  instant = new Date(),
): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return parseIsoDate(`${get("year")}-${get("month")}-${get("day")}`);
}

/** Human-readable, unambiguous date for UK guests, e.g. "Fri 25 Dec 2026". */
export function formatStayDate(date: IsoDate): string {
  // Assembled from parts so the output does not vary with ICU versions.
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(new Date(toUtcMs(date)));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** First day of the month containing `date`. */
export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 8)}01` as IsoDate;
}
