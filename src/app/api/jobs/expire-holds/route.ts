import { db, isDatabaseConfigured } from "@/server/db/client";
import { expireLapsedHolds } from "@/server/booking/holds";
import { isAuthorisedJobRequest } from "@/server/jobs/auth";

/**
 * Sweeps lapsed payment holds. Holds are also treated as expired at request
 * time, so this job only tidies state; missing a run never double-books.
 */
export async function GET(request: Request) {
  if (!isAuthorisedJobRequest(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const expired = await expireLapsedHolds(db(), null, new Date());
  return Response.json({ expired: expired.length });
}
