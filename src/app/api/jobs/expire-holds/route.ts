import { expireHoldsJob } from "@/server/jobs/definitions";
import { handleJobRequest } from "@/server/jobs/route";

/** Runs the "expire-holds" job now (under its lease). See src/server/jobs/definitions.ts. */
export const maxDuration = 300;

export function GET(request: Request) {
  return handleJobRequest(request, expireHoldsJob);
}
