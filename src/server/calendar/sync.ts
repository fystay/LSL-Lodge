import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { addDays, todayInTimeZone } from "@/lib/dates";
import type { Database } from "@/server/db/client";
import {
  auditLogs,
  externalBusyPeriods,
  externalCalendarSources,
  properties,
  reservations,
} from "@/server/db/schema";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialKey,
  type CredentialKey,
} from "@/server/crypto/credentials";
import { encryptionEnv } from "@/server/env";
import { BLOCKING_STATUSES } from "@/server/booking/reservation-state";
import { enqueueNotification } from "@/server/notifications/outbox";
import { FeedParseError, parseIcalFeed } from "./ical-parse";
import { planBusyPeriodImport, type StoredBusyPeriod } from "./import-plan";
import {
  AIRBNB_FEED_POLICY,
  FeedFetchError,
  fetchFeed,
  validateFeedUrl,
  type ConditionalState,
  type FeedFetchResult,
} from "./safe-fetch";

/**
 * iCalendar import (Airbnb and other iCal feeds).
 *
 * Honest about its limits: this polls on our schedule; Airbnb publishes
 * changes on its own. Nothing here is real-time.
 *
 * Safety rules:
 * - The feed URL is a secret: stored encrypted (bound to the source row),
 *   decrypted only here, fetched only through fetchFeed's SSRF protections,
 *   and never logged or returned. Errors carry codes only.
 * - A failed fetch or parse changes no busy periods: the last good import
 *   stays in force. The source shows ERROR, then STALE, and the owner is
 *   alerted after repeated failures.
 * - A feed that suddenly drops every upcoming block has its removals held
 *   until the owner confirms them.
 * - Imported periods never overwrite website reservations. An overlap is
 *   recorded and the owner alerted; both records stay.
 */

export const ALERT_AFTER_FAILURES = 3;
/** Recurring events are expanded this far ahead. */
const HORIZON_DAYS = 730;
const MAX_BACKOFF_MINUTES = 6 * 60;

export type FeedFetcher = (
  url: string,
  conditional: ConditionalState,
) => Promise<FeedFetchResult>;

export const defaultFetcher: FeedFetcher = (url, conditional) =>
  fetchFeed(url, { policy: AIRBNB_FEED_POLICY, conditional });

export type SyncOutcome =
  | {
      ok: true;
      notModified: boolean;
      inserted: number;
      updated: number;
      removed: number;
      heldRemovals: number;
      conflicts: number;
    }
  | { ok: false; code: string };

const context = (sourceId: string) =>
  `external_calendar_source:${sourceId}:url`;

export function credentialKeys(): CredentialKey[] {
  const env = encryptionEnv();
  return [
    parseCredentialKey(
      env.CREDENTIALS_ENCRYPTION_KEY,
      env.CREDENTIALS_ENCRYPTION_KEY_VERSION,
    ),
  ];
}

/** Adds an import source. The URL is validated, then stored only encrypted. */
export async function addIcalSource(
  db: Database,
  input: {
    propertyId: string;
    label: string;
    url: string;
    actor: string;
    keys?: CredentialKey[];
  },
): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  let url: URL;
  try {
    url = validateFeedUrl(input.url, AIRBNB_FEED_POLICY);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof FeedFetchError ? error.code : "invalid_url",
    };
  }
  const [key] = input.keys ?? credentialKeys();
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(externalCalendarSources).values({
      id,
      propertyId: input.propertyId,
      provider: "AIRBNB_ICAL",
      direction: "IMPORT",
      label: input.label,
      encryptedConfig: encryptCredential(url.href, key, context(id)),
      encryptionKeyVersion: key.version,
      staleAfterMinutes: 60,
    });
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.actor,
      action: "calendar_source.added",
      targetType: "external_calendar_source",
      targetId: id,
      metadata: { provider: "AIRBNB_ICAL", host: url.hostname },
    });
  });
  return { ok: true, id };
}

export async function syncIcalSource(
  db: Database,
  sourceId: string,
  options: {
    now?: Date;
    fetcher?: FeedFetcher;
    keys?: CredentialKey[];
    /** Apply removals that were held because the feed emptied. Owner-confirmed only. */
    confirmHeldRemovals?: boolean;
    /** Admin email, recorded when the owner confirms held removals. */
    actor?: string;
  } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const [row] = await db
    .select({ source: externalCalendarSources, timeZone: properties.timeZone })
    .from(externalCalendarSources)
    .innerJoin(
      properties,
      eq(properties.id, externalCalendarSources.propertyId),
    )
    .where(eq(externalCalendarSources.id, sourceId));
  if (!row) return { ok: false, code: "not_found" };
  const { source, timeZone } = row;
  if (source.direction !== "IMPORT" || source.provider === "GOOGLE")
    return { ok: false, code: "unsupported_source" };
  if (!source.encryptedConfig) return fail(db, source, now, "not_configured");

  let url: string;
  try {
    url = decryptCredential(
      source.encryptedConfig,
      options.keys ?? credentialKeys(),
      context(source.id),
    );
  } catch {
    return fail(db, source, now, "credential_unreadable");
  }

  let fetched: FeedFetchResult;
  try {
    // Confirming held removals needs the full feed, not a 304.
    fetched = await (options.fetcher ?? defaultFetcher)(
      url,
      options.confirmHeldRemovals
        ? {}
        : { etag: source.httpEtag, lastModified: source.httpLastModified },
    );
  } catch (error) {
    return fail(
      db,
      source,
      now,
      error instanceof FeedFetchError ? error.code : "fetch_failed",
    );
  }

  if (fetched.kind === "not_modified") {
    // Unchanged feed: keep any "held removals" warning until resolved.
    await succeed(
      db,
      source.id,
      now,
      source.lastErrorCode === "held_removals"
        ? {
            lastErrorCode: source.lastErrorCode,
            lastErrorMessage: source.lastErrorMessage,
          }
        : {},
    );
    return {
      ok: true,
      notModified: true,
      inserted: 0,
      updated: 0,
      removed: 0,
      heldRemovals: 0,
      conflicts: 0,
    };
  }

  const today = todayInTimeZone(timeZone, now);
  let parsed;
  try {
    parsed = parseIcalFeed(fetched.body, {
      propertyTimeZone: timeZone,
      expandUntil: addDays(today, HORIZON_DAYS),
    });
  } catch (error) {
    return fail(
      db,
      source,
      now,
      error instanceof FeedParseError ? `parse_${error.code}` : "parse_failed",
    );
  }

  return db.transaction(async (tx) => {
    // Serialise with booking writes for this property.
    await tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.id, source.propertyId))
      .for("update");
    const storedRows = await tx
      .select()
      .from(externalBusyPeriods)
      .where(eq(externalBusyPeriods.sourceId, source.id));
    const stored: StoredBusyPeriod[] = storedRows.map((s) => ({
      externalUid: s.externalUid,
      start: s.startsOn as StoredBusyPeriod["start"],
      end: s.endsOn as StoredBusyPeriod["end"],
      status: s.status,
      contentHash: s.contentHash,
    }));
    const plan = planBusyPeriodImport(stored, parsed.periods, today);
    const removals = options.confirmHeldRemovals
      ? [...plan.remove, ...plan.heldRemovals]
      : plan.remove;

    for (const p of [...plan.insert, ...plan.update]) {
      await tx
        .insert(externalBusyPeriods)
        .values({
          sourceId: source.id,
          propertyId: source.propertyId,
          externalUid: p.uid,
          startsOn: p.start,
          endsOn: p.end,
          status: p.status,
          contentHash: p.contentHash,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [
            externalBusyPeriods.sourceId,
            externalBusyPeriods.externalUid,
          ],
          set: {
            startsOn: p.start,
            endsOn: p.end,
            status: p.status,
            contentHash: p.contentHash,
            lastSeenAt: now,
            removedAt: null,
          },
        });
    }
    if (plan.unchanged.length > 0)
      await tx
        .update(externalBusyPeriods)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(externalBusyPeriods.sourceId, source.id),
            inArray(externalBusyPeriods.externalUid, plan.unchanged),
          ),
        );
    if (removals.length > 0)
      await tx
        .update(externalBusyPeriods)
        .set({ status: "REMOVED_FROM_SOURCE", removedAt: now })
        .where(
          and(
            eq(externalBusyPeriods.sourceId, source.id),
            inArray(externalBusyPeriods.externalUid, removals),
          ),
        );

    const held = options.confirmHeldRemovals ? 0 : plan.heldRemovals.length;
    await succeed(tx, source.id, now, {
      httpEtag: fetched.etag ?? null,
      httpLastModified: fetched.lastModified ?? null,
      lastErrorCode: held > 0 ? "held_removals" : null,
      lastErrorMessage:
        held > 0
          ? `${held} upcoming block(s) disappeared from the feed at once; kept until you confirm.`
          : null,
    });
    if (removals.length > 0 && options.confirmHeldRemovals)
      await tx.insert(auditLogs).values({
        actorType: "OWNER",
        actorId: options.actor ?? null,
        action: "calendar_source.held_removals_released",
        targetType: "external_calendar_source",
        targetId: source.id,
        metadata: { count: plan.heldRemovals.length },
      });

    const conflicts = await recordConflicts(tx, source.id, source.propertyId);
    return {
      ok: true,
      notModified: false,
      inserted: plan.insert.length,
      updated: plan.update.length,
      removed: removals.length,
      heldRemovals: held,
      conflicts,
    } as const;
  });
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SourceRow = typeof externalCalendarSources.$inferSelect;

async function succeed(
  db: Database | Tx,
  sourceId: string,
  now: Date,
  extra: Partial<typeof externalCalendarSources.$inferInsert>,
) {
  const [source] = await db
    .select({ every: externalCalendarSources.staleAfterMinutes })
    .from(externalCalendarSources)
    .where(eq(externalCalendarSources.id, sourceId));
  await db
    .update(externalCalendarSources)
    .set({
      syncStatus: "OK",
      lastAttemptAt: now,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      // Poll several times within the stale window.
      nextSyncAt: new Date(
        now.getTime() + Math.max(5, Math.floor(source.every / 4)) * 60_000,
      ),
      ...("lastErrorCode" in extra
        ? {}
        : { lastErrorCode: null, lastErrorMessage: null }),
      ...extra,
    })
    .where(eq(externalCalendarSources.id, sourceId));
}

async function fail(
  db: Database,
  source: SourceRow,
  now: Date,
  code: string,
): Promise<SyncOutcome> {
  const failures = source.consecutiveFailures + 1;
  const backoff = Math.min(MAX_BACKOFF_MINUTES, 5 * 2 ** (failures - 1));
  await db.transaction(async (tx) => {
    await tx
      .update(externalCalendarSources)
      .set({
        syncStatus: isStale(source, now) ? "STALE" : "ERROR",
        lastAttemptAt: now,
        consecutiveFailures: failures,
        lastErrorCode: code.slice(0, 60),
        lastErrorMessage: null,
        nextSyncAt: new Date(now.getTime() + backoff * 60_000),
      })
      .where(eq(externalCalendarSources.id, source.id));
    if (failures === ALERT_AFTER_FAILURES)
      await alertSyncFailure(tx, source, now);
  });
  return { ok: false, code };
}

export function isStale(
  source: Pick<SourceRow, "lastSuccessAt" | "staleAfterMinutes" | "createdAt">,
  now: Date,
): boolean {
  const since = source.lastSuccessAt ?? source.createdAt;
  return now.getTime() - since.getTime() > source.staleAfterMinutes * 60_000;
}

async function alertSyncFailure(tx: Tx, source: SourceRow, now: Date) {
  // One alert per outage: keyed on the last success (or creation).
  const since = (source.lastSuccessAt ?? source.createdAt).toISOString();
  await enqueueNotification(tx, {
    template: "owner_calendar_sync_failed",
    reservationId: null,
    idempotencyKey: `owner_calendar_sync_failed:${source.id}:${since}`,
    notBefore: now,
  });
  await tx.insert(auditLogs).values({
    actorType: "JOB",
    action: "calendar_source.failing",
    targetType: "external_calendar_source",
    targetId: source.id,
    metadata: { since },
  });
}

/**
 * Records overlaps between this source's active busy periods and blocking
 * website reservations: an audit entry and one owner alert per overlap.
 * Neither record is changed; the owner decides.
 */
async function recordConflicts(
  tx: Tx,
  sourceId: string,
  propertyId: string,
): Promise<number> {
  const rows = await tx
    .select({
      reservationId: reservations.id,
      busyPeriodId: externalBusyPeriods.id,
      contentHash: externalBusyPeriods.contentHash,
    })
    .from(externalBusyPeriods)
    .innerJoin(
      reservations,
      and(
        eq(reservations.propertyId, externalBusyPeriods.propertyId),
        sql`${reservations.stay} && ${externalBusyPeriods.stay}`,
        inArray(reservations.status, [...BLOCKING_STATUSES]),
      ),
    )
    .where(
      and(
        eq(externalBusyPeriods.sourceId, sourceId),
        eq(externalBusyPeriods.propertyId, propertyId),
        eq(externalBusyPeriods.status, "ACTIVE"),
      ),
    );
  for (const c of rows) {
    const key = `owner_calendar_conflict:${c.reservationId}:${c.busyPeriodId}:${c.contentHash}`;
    await enqueueNotification(tx, {
      template: "owner_calendar_conflict",
      reservationId: c.reservationId,
      idempotencyKey: key,
    });
  }
  return rows.length;
}

/** Sources due a poll: enabled imports whose next sync time has passed. */
export async function dueSources(db: Database, now: Date) {
  return db
    .select({ id: externalCalendarSources.id })
    .from(externalCalendarSources)
    .where(
      and(
        eq(externalCalendarSources.enabled, true),
        eq(externalCalendarSources.direction, "IMPORT"),
        inArray(externalCalendarSources.provider, [
          "AIRBNB_ICAL",
          "OTHER_ICAL",
        ]),
        or(
          isNull(externalCalendarSources.nextSyncAt),
          lte(externalCalendarSources.nextSyncAt, now),
        ),
      ),
    )
    .limit(20);
}
