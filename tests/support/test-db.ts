import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/server/db/client";
import { properties, reservations } from "@/server/db/schema";

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
