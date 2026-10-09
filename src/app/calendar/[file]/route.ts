import { todayInTimeZone } from "@/lib/dates";
import { db, isDatabaseConfigured } from "@/server/db/client";
import { PROPERTY_SLUG } from "@/server/booking/public";
import {
  buildExportFeed,
  calendarExportSecret,
  verifyExportToken,
} from "@/server/calendar/export";
import { loadPropertyBySlug } from "@/server/pricing/load";

/**
 * GET /calendar/<token>.ics — the website's availability for Airbnb to import.
 * Unknown or wrong tokens get the same 404 as a disabled feed.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/calendar/[file]">,
) {
  const { file } = await params;
  const notFound = () => new Response("Not found", { status: 404 });
  const secret = calendarExportSecret();
  const match = /^([A-Za-z0-9_-]{32})\.ics$/.exec(file);
  if (!secret || !match || !isDatabaseConfigured()) return notFound();

  const database = db();
  const property = await loadPropertyBySlug(database, PROPERTY_SLUG);
  if (!property || !verifyExportToken(secret, property.id, match[1]))
    return notFound();

  const now = new Date();
  const body = await buildExportFeed(
    database,
    property.id,
    todayInTimeZone(property.timeZone, now),
    now,
  );
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
