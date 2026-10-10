import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  externalBusyPeriods,
  externalCalendarSources,
  notificationJobs,
  ownerBlocks,
  reservations,
} from "@/server/db/schema";
import { parseCredentialKey } from "@/server/crypto/credentials";
import { createHold } from "@/server/booking/holds";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { buildExportFeed, exportToken, verifyExportToken } from "./export";
import { FeedFetchError, type FeedFetchResult } from "./safe-fetch";
import {
  ALERT_AFTER_FAILURES,
  addIcalSource,
  syncIcalSource,
  type FeedFetcher,
} from "./sync";

const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Synthetic data only: a throwaway key, a made-up feed URL and fake events.
const keys = [parseCredentialKey(randomBytes(32).toString("base64"), 1)];
const FEED_URL =
  "https://www.airbnb.co.uk/calendar/ical/123.ics?s=secret-test-token";
const NOW = new Date("2026-10-08T12:00:00Z");
const OWNER = "owner@example.test";

const calendar = (...events: [uid: string, start: string, end: string][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN",
    ...events.flatMap(([uid, start, end]) => [
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${start.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${end.replaceAll("-", "")}`,
      `UID:${uid}`,
      "SUMMARY:Reserved",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");

/** A fetcher that serves queued responses and records what it was asked. */
function feed(...responses: (FeedFetchResult | Error)[]) {
  const calls: { url: string; etag?: string | null }[] = [];
  const fetcher: FeedFetcher = async (url, conditional) => {
    calls.push({ url, etag: conditional.etag });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}
const ok = (body: string, etag = '"v1"'): FeedFetchResult => ({
  kind: "ok",
  body,
  etag,
});

async function setup() {
  const property = await createBookableProperty(db);
  const added = await addIcalSource(db, {
    propertyId: property.id,
    label: "Airbnb",
    url: FEED_URL,
    actor: OWNER,
    keys,
  });
  if (!added.ok) throw new Error(added.code);
  return { property, sourceId: added.id };
}

/** Marks a source as freshly synced, so the stale-calendar stop allows bookings. */
const markFresh = (sourceId: string, at = new Date()) =>
  db
    .update(externalCalendarSources)
    .set({ lastSuccessAt: at, syncStatus: "OK" })
    .where(eq(externalCalendarSources.id, sourceId));

const periods = (sourceId: string) =>
  db
    .select()
    .from(externalBusyPeriods)
    .where(eq(externalBusyPeriods.sourceId, sourceId));
const source = async (id: string) =>
  (
    await db
      .select()
      .from(externalCalendarSources)
      .where(eq(externalCalendarSources.id, id))
  )[0];

describe("addIcalSource", () => {
  it("stores the feed URL only encrypted", async () => {
    const { sourceId } = await setup();
    const row = await source(sourceId);
    expect(row.encryptedConfig).toBeTruthy();
    expect(row.encryptedConfig).not.toContain("airbnb");
    expect(row.encryptedConfig).not.toContain("secret-test-token");
  });

  it("refuses non-Airbnb, non-https and private-network links", async () => {
    const property = await createBookableProperty(db);
    for (const url of [
      "http://www.airbnb.co.uk/calendar/ical/1.ics",
      "https://evil.example/calendar.ics",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      const result = await addIcalSource(db, {
        propertyId: property.id,
        label: "x",
        url,
        actor: OWNER,
        keys,
      });
      expect(result.ok, url).toBe(false);
    }
    expect(await db.select().from(externalCalendarSources)).toHaveLength(0);
  });
});

describe("syncIcalSource", () => {
  it("imports busy periods that then block direct bookings", async () => {
    const { property, sourceId } = await setup();
    const { fetcher, calls } = feed(
      ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"])),
    );
    const result = await syncIcalSource(db, sourceId, {
      now: NOW,
      fetcher,
      keys,
    });
    expect(result).toMatchObject({ ok: true, inserted: 1 });
    expect(calls[0].url).toBe(FEED_URL);

    const row = await source(sourceId);
    expect(row.syncStatus).toBe("OK");
    expect(row.lastSuccessAt).toEqual(NOW);
    expect(row.httpEtag).toBe('"v1"');

    const hold = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-08"),
      checkOut: d("2027-03-12"),
      guests: 2,
      guest: { name: "Test Guest", email: "guest@example.test" },
      idempotencyKey: randomUUID(),
      now: NOW,
    });
    expect(hold).toMatchObject({ ok: false, reason: "UNAVAILABLE" });
  });

  it("uses conditional requests and treats 304 as a successful sync", async () => {
    const { sourceId } = await setup();
    const { fetcher, calls } = feed(
      ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"])),
      { kind: "not_modified" },
    );
    await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys });
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const result = await syncIcalSource(db, sourceId, {
      now: later,
      fetcher,
      keys,
    });
    expect(result).toMatchObject({ ok: true, notModified: true });
    expect(calls[1].etag).toBe('"v1"');
    expect((await source(sourceId)).lastSuccessAt).toEqual(later);
  });

  it("keeps the last good import when the feed fails, then alerts once", async () => {
    const { sourceId } = await setup();
    const good = ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"]));
    await syncIcalSource(db, sourceId, {
      now: NOW,
      fetcher: feed(good).fetcher,
      keys,
    });

    const failing = feed(new FeedFetchError("timeout"));
    for (let i = 1; i <= ALERT_AFTER_FAILURES + 2; i++) {
      const at = new Date(NOW.getTime() + i * 30 * 60_000);
      expect(
        await syncIcalSource(db, sourceId, {
          now: at,
          fetcher: failing.fetcher,
          keys,
        }),
      ).toEqual({ ok: false, code: "timeout" });
    }
    const row = await source(sourceId);
    expect(row.consecutiveFailures).toBe(ALERT_AFTER_FAILURES + 2);
    expect(row.lastErrorCode).toBe("timeout");
    // Stale after 60 minutes without success.
    expect(row.syncStatus).toBe("STALE");
    expect(row.lastErrorMessage ?? "").not.toContain("airbnb");

    const active = (await periods(sourceId)).filter(
      (p) => p.status === "ACTIVE",
    );
    expect(active).toHaveLength(1);
    const alerts = await db
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.template, "owner_calendar_sync_failed"));
    expect(alerts).toHaveLength(1);
  });

  it("marks events removed from the feed, without deleting them", async () => {
    const { sourceId } = await setup();
    const { fetcher } = feed(
      ok(
        calendar(
          ["a@airbnb.com", "2027-03-05", "2027-03-10"],
          ["b@airbnb.com", "2027-04-05", "2027-04-10"],
        ),
      ),
      ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"]), '"v2"'),
    );
    await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys });
    expect(
      await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys }),
    ).toMatchObject({ ok: true, removed: 1 });
    const rows = await periods(sourceId);
    expect(rows.find((r) => r.externalUid === "b@airbnb.com")?.status).toBe(
      "REMOVED_FROM_SOURCE",
    );
  });

  it("holds back removals when a feed suddenly empties, until the owner confirms", async () => {
    const { sourceId } = await setup();
    const { fetcher } = feed(
      ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"])),
      ok(calendar(), '"empty"'),
    );
    await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys });
    expect(
      await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys }),
    ).toMatchObject({ ok: true, removed: 0, heldRemovals: 1 });
    expect((await periods(sourceId))[0].status).toBe("ACTIVE");
    expect((await source(sourceId)).lastErrorCode).toBe("held_removals");

    expect(
      await syncIcalSource(db, sourceId, {
        now: NOW,
        fetcher,
        keys,
        confirmHeldRemovals: true,
      }),
    ).toMatchObject({ ok: true, removed: 1, heldRemovals: 0 });
    expect((await periods(sourceId))[0].status).toBe("REMOVED_FROM_SOURCE");
    expect((await source(sourceId)).lastErrorCode).toBeNull();
  });

  it("flags a clash with a website booking without changing either side", async () => {
    const { property, sourceId } = await setup();
    await markFresh(sourceId);
    const req = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-01"),
      checkOut: d("2027-03-06"),
      guests: 2,
      guest: { name: "Test Guest", email: "guest@example.test" },
      idempotencyKey: randomUUID(),
      now: new Date(),
    });
    if (!req.ok) throw new Error("expected hold");
    const { fetcher } = feed(
      ok(calendar(["a@airbnb.com", "2027-03-05", "2027-03-10"])),
    );
    expect(
      await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys }),
    ).toMatchObject({ ok: true, conflicts: 1 });
    // Re-syncing the same data doesn't alert twice.
    await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys });

    const [r] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, req.reservationId));
    expect(r.status).toBe("PENDING_PAYMENT");
    expect((await periods(sourceId))[0].status).toBe("ACTIVE");
    const alerts = await db
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.template, "owner_calendar_conflict"));
    expect(alerts).toHaveLength(1);
  });

  it("can't read the stored link with a different key", async () => {
    const { sourceId } = await setup();
    const other = [parseCredentialKey(randomBytes(32).toString("base64"), 1)];
    const { fetcher, calls } = feed(ok(calendar()));
    expect(
      await syncIcalSource(db, sourceId, { now: NOW, fetcher, keys: other }),
    ).toEqual({ ok: false, code: "credential_unreadable" });
    expect(calls).toHaveLength(0);
  });
});

describe("export feed", () => {
  it("lists website bookings and owner blocks, but never imported periods", async () => {
    const { property, sourceId } = await setup();
    await syncIcalSource(db, sourceId, {
      now: NOW,
      fetcher: feed(ok(calendar(["a@airbnb.com", "2027-05-05", "2027-05-10"])))
        .fetcher,
      keys,
    });
    await markFresh(sourceId);
    const req = await createHold(db, {
      propertyId: property.id,
      checkIn: d("2027-03-01"),
      checkOut: d("2027-03-04"),
      guests: 2,
      guest: { name: "Secret Name", email: "secret@example.test" },
      idempotencyKey: randomUUID(),
      now: new Date(),
    });
    if (!req.ok) throw new Error("expected hold");
    await db.insert(ownerBlocks).values({
      propertyId: property.id,
      startsOn: "2027-06-01",
      endsOn: "2027-06-03",
      reason: "Private reason",
      createdBy: OWNER,
    });

    const ics = await buildExportFeed(
      db,
      property.id,
      d("2026-10-08"),
      new Date(),
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20270301");
    expect(ics).toContain("DTEND;VALUE=DATE:20270304");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270601");
    expect(ics).not.toContain("20270505");
    expect(ics).not.toContain("airbnb");
    expect(ics).not.toContain("Secret");
    expect(ics).not.toContain("Private reason");
    expect(ics.split("BEGIN:VEVENT")).toHaveLength(3);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("verifies only the token for this property and secret", () => {
    const secret = "s".repeat(40);
    const token = exportToken(secret, "property-a");
    expect(verifyExportToken(secret, "property-a", token)).toBe(true);
    expect(verifyExportToken(secret, "property-b", token)).toBe(false);
    expect(verifyExportToken(`${secret}x`, "property-a", token)).toBe(false);
    expect(verifyExportToken(secret, "property-a", token.slice(1))).toBe(false);
  });
});
