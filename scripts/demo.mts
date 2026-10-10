/**
 * Demo / staging data tools. Test data only.
 *
 *   pnpm demo seed     placeholder property, rates and payment plan; marks
 *                      the database as a demo database
 *   pnpm demo status   what demo data exists
 *   pnpm demo reset    deletes demo bookings, [DEMO] blocks and [DEMO]
 *                      calendar sources, nothing else
 *
 * Safety (all enforced before anything is written):
 * - DATABASE_URL must be local, or its host must be repeated in
 *   DEMO_DATABASE_HOST (so a production URL can't be used by accident).
 * - STRIPE_SECRET_KEY, if set, must be a test key (sk_test_…).
 * - `reset` only runs on a database that `seed` marked as a demo database
 *   (audit entry "demo.seeded"), and only deletes bookings whose guest email
 *   is at a test domain (example.test, example.com, or DEMO_EMAIL_DOMAINS)
 *   plus owner blocks and calendar sources labelled "[DEMO]…". Real bookings are
 *   never selected. `reset` needs --yes.
 *
 * Every price seeded here is a made-up placeholder, not the owner's pricing.
 */
import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/server/db/schema";

const command = process.argv[2];
const yes = process.argv.includes("--yes");
const url = process.env.DATABASE_URL;
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!url) fail("Set DATABASE_URL.");
const host = new URL(url!).hostname;
const local = ["localhost", "127.0.0.1", "::1"].includes(host);
if (!local && process.env.DEMO_DATABASE_HOST !== host)
  fail(
    `Refusing to touch "${host}". If this is the Lodge demo/staging database, set DEMO_DATABASE_HOST=${host} to confirm.`,
  );
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (stripeKey && !stripeKey.startsWith("sk_test_"))
  fail("Refusing: STRIPE_SECRET_KEY is not a test key.");

const DEMO_DOMAINS = [
  "example.test",
  "example.com",
  ...(process.env.DEMO_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
];
const slug = process.env.PROPERTY_SLUG ?? "lodge-on-the-lake";
const client = postgres(url!, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema, casing: "snake_case" });

const isDemoDatabase = async (executor: Pick<typeof db, "select"> = db) =>
  (
    await executor
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "demo.seeded"))
      .limit(1)
  ).length > 0;

const demoEmail = or(
  ...DEMO_DOMAINS.map((d) =>
    like(sql`lower(${schema.reservations.guestEmail})`, `%@${d}`),
  ),
)!;

async function seed() {
  await db.transaction(async (tx) => {
    let [property] = await tx
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.slug, slug));
    if (!property) {
      [property] = await tx
        .insert(schema.properties)
        .values({
          slug,
          name: "Lodge on the Lake",
          timeZone: "Europe/London",
          maxGuests: 6,
          defaultMinNights: 2,
          turnoverNights: 0,
          checkInTime: "16:00 (placeholder)",
          checkOutTime: "10:00 (placeholder)",
          bookingsEnabled: true,
        })
        .returning();
    }
    const rates = await tx
      .select({ id: schema.rateRules.id })
      .from(schema.rateRules)
      .where(eq(schema.rateRules.propertyId, property.id));
    if (rates.length === 0) {
      await tx.insert(schema.rateRules).values({
        propertyId: property.id,
        name: "PLACEHOLDER rate — not real pricing",
        startsOn: "2026-01-01",
        endsOn: "2028-12-31",
        nightlyMinor: 15_000,
        weekendNightlyMinor: 18_000,
      });
      await tx.insert(schema.feeRules).values({
        propertyId: property.id,
        name: "Cleaning (placeholder)",
        kind: "PER_STAY",
        amountMinor: 6_000,
        taxTreatment: "UNCONFIRMED",
      });
      await tx
        .insert(schema.paymentPolicies)
        .values({ propertyId: property.id, mode: "FULL" });
    }
    if (!(await isDemoDatabase(tx)))
      await tx.insert(schema.auditLogs).values({
        actorType: "SYSTEM",
        action: "demo.seeded",
        targetType: "property",
        targetId: property.id,
        metadata: { note: "Demo/staging database: placeholder data only." },
      });
  });
  console.log(`Demo data ready for "${slug}" on ${host}.`);
}

async function demoBookings() {
  return db
    .select({
      id: schema.reservations.id,
      ref: schema.reservations.publicRef,
      status: schema.reservations.status,
      email: schema.reservations.guestEmail,
    })
    .from(schema.reservations)
    .where(demoEmail);
}

async function status() {
  const bookings = await demoBookings();
  const all = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.reservations);
  const blocks = await db
    .select({ id: schema.ownerBlocks.id })
    .from(schema.ownerBlocks)
    .where(like(schema.ownerBlocks.reason, "[DEMO]%"));
  console.log(
    JSON.stringify(
      {
        host,
        demoDatabase: await isDemoDatabase(),
        demoBookings: bookings.length,
        otherBookings: all[0].n - bookings.length,
        demoBlocks: blocks.length,
        byStatus: bookings.reduce<Record<string, number>>((acc, b) => {
          acc[b.status] = (acc[b.status] ?? 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2,
    ),
  );
}

async function reset() {
  if (!(await isDemoDatabase()))
    fail(
      "Refusing: this database was not created with `pnpm demo seed`, so it may hold real bookings.",
    );
  const bookings = await demoBookings();
  const ids = bookings.map((b) => b.id);
  console.log(
    `Will delete ${ids.length} demo booking(s) (guest email at ${DEMO_DOMAINS.join(", ")}) and [DEMO] owner blocks on ${host}.`,
  );
  if (!yes) fail("Nothing deleted. Re-run with --yes to proceed.");

  await db.transaction(async (tx) => {
    if (ids.length > 0) {
      const paymentIds = (
        await tx
          .select({ id: schema.payments.id })
          .from(schema.payments)
          .where(inArray(schema.payments.reservationId, ids))
      ).map((p) => p.id);
      await tx
        .delete(schema.notificationJobs)
        .where(inArray(schema.notificationJobs.reservationId, ids));
      await tx
        .delete(schema.calendarEventLinks)
        .where(inArray(schema.calendarEventLinks.reservationId, ids));
      await tx
        .delete(schema.payments)
        .where(
          and(
            inArray(schema.payments.reservationId, ids),
            isNotNull(schema.payments.refundOfPaymentId),
          ),
        );
      await tx
        .delete(schema.payments)
        .where(inArray(schema.payments.reservationId, ids));
      await tx
        .delete(schema.paymentScheduleItems)
        .where(inArray(schema.paymentScheduleItems.reservationId, ids));
      await tx
        .delete(schema.auditLogs)
        .where(inArray(schema.auditLogs.targetId, [...ids, ...paymentIds]));
      await tx
        .delete(schema.reservations)
        .where(inArray(schema.reservations.id, ids));
    }
    const blockIds = (
      await tx
        .select({ id: schema.ownerBlocks.id })
        .from(schema.ownerBlocks)
        .where(like(schema.ownerBlocks.reason, "[DEMO]%"))
    ).map((b) => b.id);
    if (blockIds.length > 0) {
      await tx
        .delete(schema.calendarEventLinks)
        .where(inArray(schema.calendarEventLinks.ownerBlockId, blockIds));
      await tx
        .delete(schema.auditLogs)
        .where(inArray(schema.auditLogs.targetId, blockIds));
      await tx
        .delete(schema.ownerBlocks)
        .where(inArray(schema.ownerBlocks.id, blockIds));
    }
    // Test calendar sources (the staging journey's stand-in Airbnb feed).
    const sourceIds = (
      await tx
        .select({ id: schema.externalCalendarSources.id })
        .from(schema.externalCalendarSources)
        .where(like(schema.externalCalendarSources.label, "[DEMO]%"))
    ).map((s) => s.id);
    if (sourceIds.length > 0) {
      await tx
        .delete(schema.calendarEventLinks)
        .where(inArray(schema.calendarEventLinks.sourceId, sourceIds));
      await tx
        .delete(schema.externalBusyPeriods)
        .where(inArray(schema.externalBusyPeriods.sourceId, sourceIds));
      await tx
        .delete(schema.externalCalendarSources)
        .where(inArray(schema.externalCalendarSources.id, sourceIds));
    }
    // Owner accounts the staging journey test creates (test addresses, no
    // usable password; their sessions go with them). Real owners are never
    // matched: they have a real password hash.
    await tx
      .delete(schema.adminUsers)
      .where(
        and(
          eq(schema.adminUsers.passwordHash, "unusable"),
          like(sql`lower(${schema.adminUsers.email})`, "%@example.test"),
        ),
      );
    // Demo traffic shares one address; clear counters so the next run
    // isn't rate-limited.
    await tx.delete(schema.rateLimits);
    await tx.insert(schema.auditLogs).values({
      actorType: "SYSTEM",
      action: "demo.reset",
      targetType: "property",
      metadata: { bookings: ids.length, blocks: blockIds.length },
    });
  });
  console.log("Demo data reset.");
}

try {
  if (command === "seed") await seed();
  else if (command === "status") await status();
  else if (command === "reset") await reset();
  else fail("Usage: pnpm demo <seed|status|reset> [--yes]");
} finally {
  await client.end();
}
