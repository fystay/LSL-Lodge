import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { addDays, parseIsoDate, type IsoDate } from "@/lib/dates";
import {
  fromWallTime,
  isMidnight,
  isValidTimeZone,
  toWallTime,
  wallDate,
  type WallTime,
} from "@/lib/zoned-time";

/**
 * Parses an iCalendar feed (e.g. an Airbnb calendar export) into busy periods
 * expressed as property-local nights [start, end).
 *
 * Only dates, UIDs and status are extracted. SUMMARY, DESCRIPTION, attendees
 * and similar fields are deliberately ignored: they can contain guest
 * personal data that this system has no need to hold.
 *
 * Conversion is conservative: a timed event blocks every night whose calendar
 * day it touches in the property's time zone. Over-blocking is recoverable by
 * the owner; a missed block can cause a double booking.
 */

export interface ParsedBusyPeriod {
  uid: string;
  start: IsoDate;
  end: IsoDate;
  status: "ACTIVE" | "CANCELLED";
  contentHash: string;
}

export interface ParseResult {
  periods: ParsedBusyPeriod[];
  warnings: string[];
}

export interface ParseOptions {
  propertyTimeZone: string;
  /** Recurring events are expanded up to this date (exclusive). */
  expandUntil: IsoDate;
  maxEvents?: number;
}

export class FeedParseError extends Error {
  constructor(readonly code: string) {
    super(`iCalendar feed could not be parsed (${code})`);
    this.name = "FeedParseError";
  }
}

const DEFAULT_MAX_EVENTS = 5_000;

export function parseIcalFeed(
  text: string,
  options: ParseOptions,
): ParseResult {
  if (!/^\s*BEGIN:VCALENDAR/i.test(text))
    throw new FeedParseError("not_icalendar");

  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new FeedParseError("malformed");
  }
  if (root.name !== "vcalendar") throw new FeedParseError("not_icalendar");

  const warnings = new Set<string>();
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const byUid = new Map<string, ParsedBusyPeriod>();

  const add = (period: Omit<ParsedBusyPeriod, "contentHash">) => {
    if (byUid.size >= maxEvents) throw new FeedParseError("too_many_events");
    const existing = byUid.get(period.uid);
    if (existing) {
      // Duplicate UIDs: keep the union so nothing is unblocked by accident.
      warnings.add("duplicate_uid");
      if (existing.status === "CANCELLED" && period.status === "ACTIVE")
        existing.status = "ACTIVE";
      if (period.start < existing.start) existing.start = period.start;
      if (period.end > existing.end) existing.end = period.end;
      existing.contentHash = hashPeriod(existing);
      return;
    }
    byUid.set(period.uid, { ...period, contentHash: hashPeriod(period) });
  };

  for (const vevent of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(vevent);
    const uid = event.uid?.trim();
    if (!uid) {
      warnings.add("event_without_uid");
      continue;
    }
    const dtstart = vevent.getFirstProperty("dtstart");
    if (!dtstart) {
      warnings.add("event_without_start");
      continue;
    }
    const status = String(
      vevent.getFirstPropertyValue("status") ?? "",
    ).toUpperCase();
    const periodStatus = status === "CANCELLED" ? "CANCELLED" : "ACTIVE";
    const tzid = paramString(dtstart.getParameter("tzid"));
    const endTzid =
      paramString(vevent.getFirstProperty("dtend")?.getParameter("tzid")) ??
      tzid;

    // A RECURRENCE-ID override is kept as its own busy period alongside the
    // expanded series, so a moved occurrence blocks both dates (conservative).
    const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");
    const baseUid = recurrenceId
      ? `${uid}#override-${String(recurrenceId)}`
      : uid;

    if (event.isRecurring() && !recurrenceId) {
      const durationSeconds = event.duration.toSeconds();
      const iterator = event.iterator();
      let count = 0;
      for (let next = iterator.next(); next; next = iterator.next()) {
        if (++count > maxEvents) throw new FeedParseError("too_many_events");
        const end = next.clone();
        end.addDuration(ICAL.Duration.fromSeconds(durationSeconds));
        const range = toNightRange(
          next,
          end,
          tzid,
          endTzid,
          options.propertyTimeZone,
          warnings,
        );
        if (!range || range.start >= options.expandUntil) break;
        add({ uid: `${uid}#${range.start}`, ...range, status: periodStatus });
      }
      continue;
    }

    const range = toNightRange(
      event.startDate,
      endTimeOf(event),
      tzid,
      endTzid,
      options.propertyTimeZone,
      warnings,
    );
    if (range) add({ uid: baseUid, ...range, status: periodStatus });
  }

  return {
    periods: [...byUid.values()].sort((a, b) =>
      a.start === b.start
        ? a.uid.localeCompare(b.uid)
        : a.start < b.start
          ? -1
          : 1,
    ),
    warnings: [...warnings].sort(),
  };
}

function paramString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** End time per RFC 5545 §3.6.1, including the missing-DTEND defaults. */
function endTimeOf(event: ICAL.Event): ICAL.Time | undefined {
  const component = event.component;
  if (component.hasProperty("dtend") || component.hasProperty("duration"))
    return event.endDate;
  // No DTEND/DURATION: an all-day event lasts one day; a timed event is instantaneous.
  if (event.startDate.isDate) {
    const end = event.startDate.clone();
    end.addDuration(ICAL.Duration.fromData({ days: 1 }));
    return end;
  }
  return event.startDate;
}

function toNightRange(
  start: ICAL.Time,
  end: ICAL.Time | undefined,
  startTzid: string | undefined,
  endTzid: string | undefined,
  propertyTimeZone: string,
  warnings: Set<string>,
): { start: IsoDate; end: IsoDate } | undefined {
  if (!end) return undefined;

  if (start.isDate) {
    const startDate = dateOf(start);
    let endDate = end.isDate
      ? dateOf(end)
      : localDateCeil(end, endTzid, propertyTimeZone, warnings);
    if (endDate <= startDate) {
      warnings.add("non_positive_duration");
      endDate = addDays(startDate, 1);
    }
    return { start: startDate, end: endDate };
  }

  const startWall = toPropertyWall(
    start,
    startTzid,
    propertyTimeZone,
    warnings,
  );
  const startDate = wallDate(startWall);
  let endDate = localDateCeil(end, endTzid, propertyTimeZone, warnings);
  if (endDate <= startDate) endDate = addDays(startDate, 1);
  return { start: startDate, end: endDate };
}

function dateOf(time: ICAL.Time): IsoDate {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return parseIsoDate(
    `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`,
  );
}

/** The first property-local date on or after `time` that starts at midnight. */
function localDateCeil(
  time: ICAL.Time,
  tzid: string | undefined,
  propertyTimeZone: string,
  warnings: Set<string>,
): IsoDate {
  if (time.isDate) return dateOf(time);
  const wall = toPropertyWall(time, tzid, propertyTimeZone, warnings);
  const date = wallDate(wall);
  return isMidnight(wall) ? date : addDays(date, 1);
}

/** Converts an iCalendar time to wall-clock time in the property's zone. */
function toPropertyWall(
  time: ICAL.Time,
  tzid: string | undefined,
  propertyTimeZone: string,
  warnings: Set<string>,
): WallTime {
  const wall: WallTime = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
  const isUtc =
    time.zone?.tzid === "UTC" || time.zone === ICAL.Timezone.utcTimezone;
  let sourceZone: string;
  if (isUtc) {
    sourceZone = "UTC";
  } else if (tzid && isValidTimeZone(tzid)) {
    sourceZone = tzid;
  } else {
    // Floating time, or a non-IANA TZID: interpret in the property's zone.
    if (tzid) warnings.add("unknown_tzid");
    sourceZone = propertyTimeZone;
  }
  if (sourceZone === propertyTimeZone) return wall;
  return toWallTime(fromWallTime(wall, sourceZone), propertyTimeZone);
}

function hashPeriod(period: Omit<ParsedBusyPeriod, "contentHash">): string {
  return createHash("sha256")
    .update(`${period.uid}\n${period.start}\n${period.end}\n${period.status}`)
    .digest("hex");
}
