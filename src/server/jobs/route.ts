import "server-only";
import { db, isDatabaseConfigured } from "@/server/db/client";
import { isAuthorisedJobRequest } from "./auth";
import { runJob, type JobDefinition } from "./runner";

/**
 * Shared handler for a single-job route: authenticate the scheduler, run the
 * job under its lease, and report the outcome (counts and codes only).
 * 200 when it ran or was skipped because another run holds the lease; 500
 * when it failed, so a scheduler that retries on errors will retry.
 */
export async function handleJobRequest(request: Request, job: JobDefinition) {
  if (!isAuthorisedJobRequest(request))
    return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isDatabaseConfigured())
    return Response.json({ error: "not_configured" }, { status: 503 });
  const outcome = await runJob(db(), job);
  return Response.json(
    { job: job.name, ...outcome },
    { status: outcome.status === "FAILED" ? 500 : 200 },
  );
}
