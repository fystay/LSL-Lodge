import type { IsoDate } from "@/lib/dates";
import type { ParsedBusyPeriod } from "./ical-parse";

/**
 * Decides how a freshly parsed feed changes the stored busy periods for one
 * source. Pure, so the safety rules are unit-testable:
 *
 * - New or changed events are upserted; unchanged ones only refresh lastSeen.
 * - Events missing from the feed are marked REMOVED_FROM_SOURCE (never hard
 *   deleted), which unblocks those dates.
 * - If a feed that previously listed upcoming blocks suddenly lists none, the
 *   removals are held back and the import is flagged for owner review. A
 *   provider glitch must never silently release booked dates.
 */

export interface StoredBusyPeriod {
  externalUid: string;
  start: IsoDate;
  end: IsoDate;
  status: "ACTIVE" | "CANCELLED" | "REMOVED_FROM_SOURCE";
  contentHash: string;
}

export interface ImportPlan {
  insert: ParsedBusyPeriod[];
  update: ParsedBusyPeriod[];
  unchanged: string[];
  remove: string[];
  /** Removals withheld pending owner confirmation. */
  heldRemovals: string[];
  warnings: string[];
}

export function planBusyPeriodImport(
  stored: readonly StoredBusyPeriod[],
  parsed: readonly ParsedBusyPeriod[],
  today: IsoDate,
): ImportPlan {
  const storedByUid = new Map(stored.map((s) => [s.externalUid, s]));
  const parsedUids = new Set(parsed.map((p) => p.uid));
  const plan: ImportPlan = {
    insert: [],
    update: [],
    unchanged: [],
    remove: [],
    heldRemovals: [],
    warnings: [],
  };

  for (const period of parsed) {
    const existing = storedByUid.get(period.uid);
    if (!existing) plan.insert.push(period);
    else if (
      existing.contentHash !== period.contentHash ||
      existing.status === "REMOVED_FROM_SOURCE"
    )
      plan.update.push(period);
    else plan.unchanged.push(period.uid);
  }

  const missing = stored.filter(
    (s) => s.status !== "REMOVED_FROM_SOURCE" && !parsedUids.has(s.externalUid),
  );

  const hadUpcoming = stored.some(
    (s) => s.status === "ACTIVE" && s.end > today,
  );
  const hasUpcoming = parsed.some(
    (p) => p.status === "ACTIVE" && p.end > today,
  );
  const missingUpcoming = missing.filter(
    (s) => s.status === "ACTIVE" && s.end > today,
  );

  if (hadUpcoming && !hasUpcoming && missingUpcoming.length > 0) {
    plan.heldRemovals = missing.map((s) => s.externalUid);
    plan.warnings.push("feed_emptied_upcoming_blocks");
  } else {
    plan.remove = missing.map((s) => s.externalUid);
  }

  return plan;
}
