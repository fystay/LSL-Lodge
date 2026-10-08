import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Scheduler calls must present `Authorization: Bearer <CRON_SECRET>` (the
 * form Vercel Cron sends). Fails closed when no secret is configured.
 */
export function isAuthorisedJobRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
