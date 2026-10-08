import { describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import { conflictingBlocks, nightStatuses, type Block } from "./availability";

const block = (
  start: string,
  end: string,
  source: Block["source"] = "DIRECT_BOOKING",
): Block => ({
  id: `${start}-${end}`,
  start: d(start),
  end: d(end),
  source,
});
const stay = (start: string, end: string) => ({ start: d(start), end: d(end) });

describe("conflictingBlocks", () => {
  const existing = [block("2026-11-10", "2026-11-13")];

  it("allows same-day turnover without a buffer", () => {
    expect(
      conflictingBlocks(existing, stay("2026-11-13", "2026-11-15"), 0),
    ).toEqual([]);
    expect(
      conflictingBlocks(existing, stay("2026-11-08", "2026-11-10"), 0),
    ).toEqual([]);
  });

  it("detects overlaps", () => {
    expect(
      conflictingBlocks(existing, stay("2026-11-12", "2026-11-14"), 0),
    ).toHaveLength(1);
    expect(
      conflictingBlocks(existing, stay("2026-11-01", "2026-11-30"), 0),
    ).toHaveLength(1);
  });

  it("applies a one-night turnover buffer on both sides", () => {
    expect(
      conflictingBlocks(existing, stay("2026-11-13", "2026-11-15"), 1),
    ).toHaveLength(1);
    expect(
      conflictingBlocks(existing, stay("2026-11-14", "2026-11-16"), 1),
    ).toEqual([]);
    expect(
      conflictingBlocks(existing, stay("2026-11-08", "2026-11-10"), 1),
    ).toHaveLength(1);
    expect(
      conflictingBlocks(existing, stay("2026-11-07", "2026-11-09"), 1),
    ).toEqual([]);
  });

  it("treats every source as blocking", () => {
    for (const source of [
      "HOLD",
      "OWNER_BLOCK",
      "AIRBNB_ICAL",
      "GOOGLE",
    ] as const) {
      expect(
        conflictingBlocks(
          [block("2026-11-10", "2026-11-13", source)],
          stay("2026-11-11", "2026-11-12"),
          0,
        ),
      ).toHaveLength(1);
    }
  });
});

describe("nightStatuses", () => {
  it("marks booked nights and turnover nights", () => {
    const statuses = nightStatuses(
      [block("2026-11-10", "2026-11-12")],
      stay("2026-11-08", "2026-11-14"),
      1,
    );
    expect(Object.fromEntries(statuses)).toEqual({
      "2026-11-08": "available",
      "2026-11-09": "turnover",
      "2026-11-10": "booked",
      "2026-11-11": "booked",
      "2026-11-12": "turnover",
      "2026-11-13": "available",
    });
  });

  it("never downgrades a booked night to turnover", () => {
    const statuses = nightStatuses(
      [block("2026-11-10", "2026-11-12"), block("2026-11-12", "2026-11-14")],
      stay("2026-11-10", "2026-11-14"),
      1,
    );
    expect([...statuses.values()]).toEqual([
      "booked",
      "booked",
      "booked",
      "booked",
    ]);
  });
});
