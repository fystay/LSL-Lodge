import { createHash, timingSafeEqual } from "node:crypto";
import { db, isDatabaseConfigured } from "@/server/db/client";
import { systemHealth } from "@/server/jobs/health";

/**
 * Health for an external uptime monitor: 200 when every job has succeeded
 * recently and nothing is backed up or failing, 503 otherwise. This is what
 * catches a scheduler that has stopped altogether.
 *
 * Requires `Authorization: Bearer $HEALTHCHECK_SECRET` (32+ characters), a
 * separate, read-only secret so the monitor never holds CRON_SECRET. The
 * body lists problem codes only.
 */
export async function GET(request: Request) {
  const secret = process.env.HEALTHCHECK_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (
    !secret ||
    secret.length < 32 ||
    !timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
  )
    return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isDatabaseConfigured())
    return Response.json(
      { ok: false, problems: ["database_not_configured"] },
      { status: 503 },
    );
  const health = await systemHealth(db(), new Date());
  return Response.json(
    { ok: health.ok, problems: health.problems },
    { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
