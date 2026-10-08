import { parseIsoDate, type IsoDate } from "./dates";

/**
 * Conversions between UTC instants and wall-clock time in an IANA zone, using
 * only the platform's Intl time-zone database.
 */

export interface WallTime {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function toWallTime(instant: Date, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(instantMs: number, timeZone: string): number {
  const w = toWallTime(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the zone's clocks show `wall`. Wall times inside a
 * daylight-saving gap or overlap resolve to an adjacent valid instant within
 * an hour, which never changes the calendar date for zones (like
 * Europe/London) whose transitions happen in the early hours.
 */
export function fromWallTime(wall: WallTime, timeZone: string): Date {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const first = naive - offsetMs(naive, timeZone);
  const second = naive - offsetMs(first, timeZone);
  return new Date(Math.min(first, second));
}

export function wallDate(wall: WallTime): IsoDate {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return parseIsoDate(
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`,
  );
}

export function isMidnight(wall: WallTime): boolean {
  return wall.hour === 0 && wall.minute === 0 && wall.second === 0;
}
