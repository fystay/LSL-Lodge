import { db, isDatabaseConfigured } from "@/server/db/client";
import { isAuthorisedJobRequest } from "@/server/jobs/auth";
import { dispatchNotifications } from "@/server/notifications/dispatch";
import { getEmailSender } from "@/server/notifications/email";

/**
 * Delivers due notification jobs. Call every few minutes from the scheduler
 * with `Authorization: Bearer $CRON_SECRET`. With email delivery off (the
 * default) jobs are marked "not sent" and can be previewed in admin.
 */
export async function GET(request: Request) {
  if (!isAuthorisedJobRequest(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const result = await dispatchNotifications(db(), getEmailSender());
  return Response.json(result);
}
