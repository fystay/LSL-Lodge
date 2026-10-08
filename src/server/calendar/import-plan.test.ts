import { describe, expect, it } from "vitest";
import { parseIsoDate } from "@/lib/dates";
import type { ParsedBusyPeriod } from "./ical-parse";
import { planBusyPeriodImport, type StoredBusyPeriod } from "./import-plan";

const today = parseIsoDate("2026-10-08");

const parsed = (
  uid: string,
  start: string,
  end: string,
  hash = `${uid}-${start}-${end}`,
) =>
  ({
    uid,
    start: parseIsoDate(start),
    end: parseIsoDate(end),
    status: "ACTIVE",
    contentHash: hash,
  }) satisfies ParsedBusyPeriod;

const stored = (
  p: ParsedBusyPeriod,
  status: StoredBusyPeriod["status"] = "ACTIVE",
): StoredBusyPeriod => ({
  externalUid: p.uid,
  start: p.start,
  end: p.end,
  status,
  contentHash: p.contentHash,
});

describe("planBusyPeriodImport", () => {
  const a = parsed("a", "2026-11-01", "2026-11-04");
  const b = parsed("b", "2026-12-01", "2026-12-03");

  it("inserts new events and leaves unchanged ones alone", () => {
    const plan = planBusyPeriodImport([stored(a)], [a, b], today);
    expect(plan.insert.map((p) => p.uid)).toEqual(["b"]);
    expect(plan.unchanged).toEqual(["a"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("updates events whose dates changed", () => {
    const moved = parsed("a", "2026-11-02", "2026-11-05");
    const plan = planBusyPeriodImport([stored(a)], [moved, b], today);
    expect(plan.update.map((p) => p.uid)).toEqual(["a"]);
  });

  it("removes events that disappear from a feed that still has upcoming blocks", () => {
    const plan = planBusyPeriodImport([stored(a), stored(b)], [b], today);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.heldRemovals).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("holds removals when a feed suddenly drops every upcoming block", () => {
    const plan = planBusyPeriodImport([stored(a), stored(b)], [], today);
    expect(plan.remove).toEqual([]);
    expect(plan.heldRemovals.sort()).toEqual(["a", "b"]);
    expect(plan.warnings).toEqual(["feed_emptied_upcoming_blocks"]);
  });

  it("does not hold removals when only past blocks disappear", () => {
    const past = parsed("old", "2026-09-01", "2026-09-04");
    const plan = planBusyPeriodImport([stored(past)], [], today);
    expect(plan.remove).toEqual(["old"]);
    expect(plan.warnings).toEqual([]);
  });

  it("re-activates an event that reappears after removal", () => {
    const plan = planBusyPeriodImport(
      [stored(a, "REMOVED_FROM_SOURCE")],
      [a],
      today,
    );
    expect(plan.update.map((p) => p.uid)).toEqual(["a"]);
  });

  it("does not repeatedly remove already-removed events", () => {
    const plan = planBusyPeriodImport(
      [stored(a, "REMOVED_FROM_SOURCE"), stored(b)],
      [b],
      today,
    );
    expect(plan.remove).toEqual([]);
  });
});
