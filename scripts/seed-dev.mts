/**
 * Seeds a LOCAL database with placeholder data so the booking flow can be
 * exercised in development and end-to-end tests.
 *
 *   DATABASE_URL=postgres://…@localhost/lodge_dev pnpm db:seed:dev
 *
 * Every price here is a made-up placeholder, NOT the owner's pricing. The
 * script refuses to run against anything but a local database.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/server/db/schema";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to a local database.");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Refusing to seed non-local database host "${host}".`);
  process.exit(1);
}

const slug = process.env.PROPERTY_SLUG ?? "lodge-on-the-lake";
const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema, casing: "snake_case" });

try {
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

    const existingRates = await tx
      .select({ id: schema.rateRules.id })
      .from(schema.rateRules)
      .where(eq(schema.rateRules.propertyId, property.id));
    if (existingRates.length === 0) {
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
      // Full payment when booking (instant booking). Amounts above
      // are still placeholders.
      await tx.insert(schema.paymentPolicies).values({
        propertyId: property.id,
        mode: "FULL",
      });
    }
  });
  console.log(`Seeded placeholder data for "${slug}".`);
} finally {
  await client.end();
}
