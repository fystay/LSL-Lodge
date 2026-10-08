import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  eachNight,
  formatStayDate,
  isIsoDate,
  isoWeekday,
  nights,
  parseIsoDate,
  rangesOverlap,
  todayInTimeZone,
  type DateRange,
} from "./dates";

const d = parseIsoDate;
const range = (start: string, end: string): DateRange => ({
  start: d(start),
  end: d(end),
});

describe("isIsoDate", () => {
  it.each(["2026-01-01", "2028-02-29", "2026-12-31"])("accepts %s", (v) => {
    expect(isIsoDate(v)).toBe(true);
  });
  it.each([
    "2026-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-1-1",
    "2026-01-01T00:00",
    "",
    "not a date",
  ])("rejects %s", (v) => {
    expect(isIsoDate(v)).toBe(false);
  });
});

describe("date arithmetic across daylight-saving changes (Europe/London)", () => {
  // Clocks go forward on 29 Mar 2026 and back on 25 Oct 2026.
  it("adds one calendar day over the spring transition", () => {
    expect(addDays(d("2026-03-28"), 1)).toBe("2026-03-29");
    expect(addDays(d("2026-03-29"), 1)).toBe("2026-03-30");
  });
  it("adds one calendar day over the autumn transition", () => {
    expect(addDays(d("2026-10-24"), 1)).toBe("2026-10-25");
    expect(addDays(d("2026-10-25"), 1)).toBe("2026-10-26");
  });
  it("counts nights correctly over both transitions", () => {
    expect(nights(range("2026-03-27", "2026-03-30"))).toBe(3);
    expect(nights(range("2026-10-23", "2026-10-26"))).toBe(3);
  });
  it("handles month, year and leap-day boundaries", () => {
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
    expect(daysBetween(d("2026-01-01"), d("2027-01-01"))).toBe(365);
  });
});

describe("stay ranges are [check-in, check-out)", () => {
  it("lists each night, excluding the check-out date", () => {
    expect(eachNight(range("2026-07-10", "2026-07-13"))).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
  });
  it("allows a same-day turnover (touching ranges do not overlap)", () => {
    expect(
      rangesOverlap(
        range("2026-07-10", "2026-07-13"),
        range("2026-07-13", "2026-07-15"),
      ),
    ).toBe(false);
  });
  it("detects overlap of a single night", () => {
    expect(
      rangesOverlap(
        range("2026-07-10", "2026-07-13"),
        range("2026-07-12", "2026-07-15"),
      ),
    ).toBe(true);
  });
  it("detects containment", () => {
    expect(
      rangesOverlap(
        range("2026-07-01", "2026-07-31"),
        range("2026-07-10", "2026-07-11"),
      ),
    ).toBe(true);
  });
});

describe("todayInTimeZone", () => {
  it("uses the property's local date, not UTC", () => {
    // 23:30 UTC on 30 Jun 2026 is 00:30 BST on 1 Jul.
    const instant = new Date("2026-06-30T23:30:00Z");
    expect(todayInTimeZone("Europe/London", instant)).toBe("2026-07-01");
    expect(todayInTimeZone("UTC", instant)).toBe("2026-06-30");
  });
  it("is correct in winter (GMT = UTC)", () => {
    const instant = new Date("2026-12-31T23:30:00Z");
    expect(todayInTimeZone("Europe/London", instant)).toBe("2026-12-31");
  });
});

describe("formatting", () => {
  it("formats dates for UK guests without time-zone drift", () => {
    expect(formatStayDate(d("2026-12-25"))).toBe("Fri 25 Dec 2026");
  });
  it("computes ISO weekdays", () => {
    expect(isoWeekday(d("2026-10-05"))).toBe(1); // Monday
    expect(isoWeekday(d("2026-10-11"))).toBe(7); // Sunday
  });
});
