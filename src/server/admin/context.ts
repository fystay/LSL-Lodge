import "server-only";
import { connection } from "next/server";
import { todayInTimeZone } from "@/lib/dates";
import { db, isDatabaseConfigured } from "@/server/db/client";
import { PROPERTY_SLUG } from "@/server/booking/public";
import { loadPropertyBySlug } from "@/server/pricing/load";
import { requireAdmin } from "./auth";

/** Authenticated admin + database + property, or a reason the admin can't work yet. */
export async function adminContext() {
  // Admin pages are always rendered per request (and read the clock).
  await connection();
  const admin = await requireAdmin();
  if (!isDatabaseConfigured())
    return {
      admin,
      ready: false as const,
      reason: "No database is configured.",
    };
  const database = db();
  const property = await loadPropertyBySlug(database, PROPERTY_SLUG);
  if (!property)
    return {
      admin,
      ready: false as const,
      reason: `No property with slug "${PROPERTY_SLUG}" exists yet.`,
    };
  const now = new Date();
  return {
    admin,
    ready: true as const,
    db: database,
    property,
    now,
    today: todayInTimeZone(property.timeZone, now),
  };
}

export type ReadyAdminContext = Extract<
  Awaited<ReturnType<typeof adminContext>>,
  { ready: true }
>;
