import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/server/db/client";
import {
  paymentPolicies,
  properties,
  rateRules,
  reservations,
} from "@/server/db/schema";

export function testDatabase(max = 10): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return createDatabase(url, { max });
}

export async function resetTables(db: Database) {
  await db.execute(sql`
    TRUNCATE audit_logs, notification_jobs, webhook_events, calendar_event_links,
      external_busy_periods, external_calendar_sources, owner_blocks, payments,
      payment_schedule_items, reservations, payment_policies, fee_rules, rate_rules,
      properties RESTART IDENTITY CASCADE
  `);
}

export async function createProperty(db: Database) {
  const [row] = await db
    .insert(properties)
    .values({ slug: `test-${randomUUID()}`, name: "Test lodge", maxGuests: 6 })
    .returning();
  return row;
}

export function holdValues(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  overrides: Partial<typeof reservations.$inferInsert> = {},
): typeof reservations.$inferInsert {
  const unique = randomUUID();
  return {
    publicRef: `T-${unique.slice(0, 8)}`,
    propertyId,
    source: "DIRECT",
    status: "PENDING_PAYMENT",
    checkIn,
    checkOut,
    guests: 2,
    guestName: "Test Guest",
    guestEmail: "guest@example.test",
    currency: "GBP",
    totalMinor: 50_000,
    quoteSnapshot: { test: true },
    holdExpiresAt: new Date(Date.now() + 15 * 60_000),
    idempotencyKey: unique,
    accessTokenHash: "test-hash",
    ...overrides,
  };
}

/** Walks the error chain for a PostgreSQL error code (drizzle wraps driver errors). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * A property that takes bookings: £100 a night through 2027, 2-night minimum.
 * Payment plan defaults to full payment (the owner's chosen model). Test data only.
 */
export async function createBookableProperty(
  db: Database,
  overrides: Partial<typeof properties.$inferInsert> = {},
  policy: Partial<typeof paymentPolicies.$inferInsert> = { mode: "FULL" },
) {
  const [property] = await db
    .insert(properties)
    .values({
      slug: `lodge-${randomUUID()}`,
      name: "Test lodge",
      maxGuests: 6,
      defaultMinNights: 2,
      bookingsEnabled: true,
      ...overrides,
    })
    .returning();
  await db.insert(rateRules).values({
    propertyId: property.id,
    name: "Test rate",
    startsOn: "2026-01-01",
    endsOn: "2028-01-01",
    nightlyMinor: 10_000,
  });
  await db.insert(paymentPolicies).values({
    propertyId: property.id,
    mode: "FULL",
    ...policy,
  });
  return property;
}
