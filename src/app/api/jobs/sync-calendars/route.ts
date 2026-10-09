import { db, isDatabaseConfigured } from "@/server/db/client";
import { isAuthorisedJobRequest } from "@/server/jobs/auth";
import { dueSources, syncIcalSource } from "@/server/calendar/sync";

/**
 * Polls imported iCal feeds that are due (target every 5–15 minutes; each
 * source sets its own next time, with backoff after failures). This bounds
 * only our side of the delay: Airbnb publishes changes on its own schedule.
 */
export async function GET(request: Request) {
  if (!isAuthorisedJobRequest(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const database = db();
  const now = new Date();
  const results = [];
  for (const { id } of await dueSources(database, now)) {
    const outcome = await syncIcalSource(database, id, { now });
    // Codes and counts only: never the feed URL.
    results.push({ id, ...outcome });
  }
  return Response.json({ synced: results.length, results });
}
