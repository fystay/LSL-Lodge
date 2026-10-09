import { db, isDatabaseConfigured } from "@/server/db/client";
import { expireLapsedHolds } from "@/server/booking/holds";
import { isAuthorisedJobRequest } from "@/server/jobs/auth";
import { cancelOpenCheckouts } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import { pruneRateLimits } from "@/server/security/rate-limit";

/**
 * Sweeps lapsed requests, approvals awaiting payment and instant holds, then
 * closes their open Stripe Checkout Sessions. Deadlines are also enforced at
 * request time, so this job only tidies state and sends the "expired"
 * messages; missing a run never double-books.
 */
export async function GET(request: Request) {
  if (!isAuthorisedJobRequest(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const database = db();
  const expired = await expireLapsedHolds(database, null, new Date());
  await cancelOpenCheckouts(database, getPaymentGateway(), expired);
  await pruneRateLimits(database);
  return Response.json({ expired: expired.length });
}
