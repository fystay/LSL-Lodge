import { describe, expect, it } from "vitest";
import { parseIsoDate } from "@/lib/dates";
import { FeedParseError, parseIcalFeed } from "./ical-parse";

const options = {
  propertyTimeZone: "Europe/London",
  expandUntil: parseIsoDate("2027-12-31"),
};

const calendar = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");

const vevent = (...lines: string[]) =>
  ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

// Shape of a typical Airbnb export (synthetic data, no real reservations).
const airbnbStyle = calendar(
  vevent(
    "DTEND;VALUE=DATE:20261013",
    "DTSTART;VALUE=DATE:20261010",
    "UID:abc123@airbnb.com",
    "DESCRIPTION:Reservation URL: https://www.airbnb.co.uk/hosting/reservations/details/XXXX",
    "SUMMARY:Reserved",
  ),
  vevent(
    "DTEND;VALUE=DATE:20261102",
    "DTSTART;VALUE=DATE:20261030",
    "UID:def456@airbnb.com",
    "SUMMARY:Airbnb (Not available)",
  ),
);

describe("parseIcalFeed", () => {
  it("reads all-day Airbnb-style events as [check-in, check-out)", () => {
    const { periods, warnings } = parseIcalFeed(airbnbStyle, options);
    expect(warnings).toEqual([]);
    expect(
      periods.map(({ uid, start, end, status }) => ({
        uid,
        start,
        end,
        status,
      })),
    ).toEqual([
      {
        uid: "abc123@airbnb.com",
        start: "2026-10-10",
        end: "2026-10-13",
        status: "ACTIVE",
      },
      {
        uid: "def456@airbnb.com",
        start: "2026-10-30",
        end: "2026-11-02",
        status: "ACTIVE",
      },
    ]);
  });

  it("does not retain summaries, descriptions or other free text", () => {
    const { periods } = parseIcalFeed(airbnbStyle, options);
    const serialised = JSON.stringify(periods);
    expect(serialised).not.toContain("Reserved");
    expect(serialised).not.toContain("hosting/reservations");
  });

  it("produces stable content hashes that change when dates change", () => {
    const a = parseIcalFeed(airbnbStyle, options).periods[0].contentHash;
    const b = parseIcalFeed(airbnbStyle, options).periods[0].contentHash;
    const moved = parseIcalFeed(
      airbnbStyle.replace("20261013", "20261014"),
      options,
    ).periods[0];
    expect(a).toBe(b);
    expect(moved.contentHash).not.toBe(a);
  });

  it("marks cancelled events", () => {
    const feed = calendar(
      vevent(
        "UID:c1",
        "DTSTART;VALUE=DATE:20261201",
        "DTEND;VALUE=DATE:20261203",
        "STATUS:CANCELLED",
      ),
    );
    expect(parseIcalFeed(feed, options).periods[0].status).toBe("CANCELLED");
  });

  it("defaults an all-day event without DTEND to one night", () => {
    const feed = calendar(vevent("UID:d1", "DTSTART;VALUE=DATE:20261201"));
    const [p] = parseIcalFeed(feed, options).periods;
    expect([p.start, p.end]).toEqual(["2026-12-01", "2026-12-02"]);
  });

  it("supports DURATION instead of DTEND", () => {
    const feed = calendar(
      vevent("UID:d2", "DTSTART;VALUE=DATE:20261201", "DURATION:P3D"),
    );
    const [p] = parseIcalFeed(feed, options).periods;
    expect([p.start, p.end]).toEqual(["2026-12-01", "2026-12-04"]);
  });

  it("converts UTC times to property-local dates (summer, BST)", () => {
    // 23:30Z on 30 Jun is 00:30 BST on 1 Jul; ends 10:00Z (11:00 BST) on 3 Jul.
    const feed = calendar(
      vevent("UID:t1", "DTSTART:20260630T233000Z", "DTEND:20260703T100000Z"),
    );
    const [p] = parseIcalFeed(feed, options).periods;
    // Touches local days 1, 2 and 3 Jul, so nights 1–3 Jul are blocked.
    expect([p.start, p.end]).toEqual(["2026-07-01", "2026-07-04"]);
  });

  it("treats an end exactly at local midnight as exclusive", () => {
    const feed = calendar(
      vevent("UID:t2", "DTSTART:20261201T150000Z", "DTEND:20261203T000000Z"),
    );
    const [p] = parseIcalFeed(feed, options).periods;
    expect([p.start, p.end]).toEqual(["2026-12-01", "2026-12-03"]);
  });

  it("honours an IANA TZID on timed events", () => {
    // 20:00 in New York on 1 Dec is 01:00 GMT on 2 Dec.
    const feed = calendar(
      vevent(
        "UID:t3",
        "DTSTART;TZID=America/New_York:20261201T200000",
        "DTEND;TZID=America/New_York:20261201T210000",
      ),
    );
    const [p] = parseIcalFeed(feed, options).periods;
    expect([p.start, p.end]).toEqual(["2026-12-02", "2026-12-03"]);
  });

  it("interprets floating and unknown-zone times in the property zone, with a warning", () => {
    const feed = calendar(
      vevent(
        "UID:t4",
        "DTSTART;TZID=Not/AZone:20261201T090000",
        "DTEND;TZID=Not/AZone:20261201T100000",
      ),
    );
    const { periods, warnings } = parseIcalFeed(feed, options);
    expect([periods[0].start, periods[0].end]).toEqual([
      "2026-12-01",
      "2026-12-02",
    ]);
    expect(warnings).toContain("unknown_tzid");
  });

  it("handles a stay across the October clock change", () => {
    const feed = calendar(
      vevent("UID:dst", "DTSTART:20261023T150000Z", "DTEND:20261026T100000Z"),
    );
    const [p] = parseIcalFeed(feed, options).periods;
    expect([p.start, p.end]).toEqual(["2026-10-23", "2026-10-27"]);
  });

  it("expands recurring events up to the horizon", () => {
    const feed = calendar(
      vevent(
        "UID:weekly",
        "DTSTART;VALUE=DATE:20261202",
        "DTEND;VALUE=DATE:20261203",
        "RRULE:FREQ=WEEKLY",
      ),
    );
    const { periods } = parseIcalFeed(feed, {
      ...options,
      expandUntil: parseIsoDate("2026-12-31"),
    });
    expect(periods.map((p) => p.start)).toEqual([
      "2026-12-02",
      "2026-12-09",
      "2026-12-16",
      "2026-12-23",
      "2026-12-30",
    ]);
    expect(new Set(periods.map((p) => p.uid)).size).toBe(5);
  });

  it("keeps the union of duplicate UIDs rather than losing a block", () => {
    const feed = calendar(
      vevent(
        "UID:dup",
        "DTSTART;VALUE=DATE:20261201",
        "DTEND;VALUE=DATE:20261203",
      ),
      vevent(
        "UID:dup",
        "DTSTART;VALUE=DATE:20261202",
        "DTEND;VALUE=DATE:20261205",
      ),
    );
    const { periods, warnings } = parseIcalFeed(feed, options);
    expect(periods).toHaveLength(1);
    expect([periods[0].start, periods[0].end]).toEqual([
      "2026-12-01",
      "2026-12-05",
    ]);
    expect(warnings).toContain("duplicate_uid");
  });

  it("skips events without a UID and reports it", () => {
    const feed = calendar(vevent("DTSTART;VALUE=DATE:20261201"));
    const { periods, warnings } = parseIcalFeed(feed, options);
    expect(periods).toEqual([]);
    expect(warnings).toContain("event_without_uid");
  });

  it("accepts a valid but empty calendar", () => {
    expect(parseIcalFeed(calendar(), options)).toEqual({
      periods: [],
      warnings: [],
    });
  });

  it.each([
    ["an HTML error page", "<!doctype html><html><body>Error</body></html>"],
    ["an empty body", ""],
    ["truncated content", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x"],
  ])("rejects %s", (_, body) => {
    expect(() => parseIcalFeed(body, options)).toThrow(FeedParseError);
  });

  it("caps the number of events", () => {
    const events = Array.from({ length: 11 }, (_, i) =>
      vevent(
        `UID:e${i}`,
        `DTSTART;VALUE=DATE:202612${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(() =>
      parseIcalFeed(calendar(...events), { ...options, maxEvents: 10 }),
    ).toThrow(FeedParseError);
  });
});
