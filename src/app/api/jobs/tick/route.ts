import { db, isDatabaseConfigured } from "@/server/db/client";
import { isAuthorisedJobRequest } from "@/server/jobs/auth";
import { JOBS } from "@/server/jobs/definitions";
import { isDue, runJob } from "@/server/jobs/runner";

/**
 * The one endpoint a scheduler needs: call it every 5 minutes with
 * `Authorization: Bearer $CRON_SECRET`. Each job runs if due, under its own
 * lease, one after another. Overlapping ticks are harmless: a job whose
 * lease is held is skipped.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedJobRequest(request))
    return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isDatabaseConfigured())
    return Response.json({ error: "not_configured" }, { status: 503 });
  const database = db();
  const results: Record<string, unknown> = {};
  let failed = false;
  for (const job of JOBS) {
    if (!(await isDue(database, job, new Date()))) {
      results[job.name] = { status: "NOT_DUE" };
      continue;
    }
    const outcome = await runJob(database, job, new Date());
    results[job.name] = outcome;
    if (outcome.status === "FAILED") failed = true;
  }
  return Response.json({ results }, { status: failed ? 500 : 200 });
}
