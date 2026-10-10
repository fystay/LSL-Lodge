import "server-only";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { externalCalendarSources } from "@/server/db/schema";
import { pruneSessions } from "@/server/admin/accounts";
import { expireLapsedHolds } from "@/server/booking/holds";
import { dueSources, syncIcalSource } from "@/server/calendar/sync";
import { dispatchNotifications } from "@/server/notifications/dispatch";
import { getEmailSender } from "@/server/notifications/email";
import { enqueueNotification } from "@/server/notifications/outbox";
import { cancelOpenCheckouts } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import { processPendingRefunds } from "@/server/payments/refunds";
import { pruneRateLimits } from "@/server/security/rate-limit";
import { systemHealth } from "./health";
import {
  pruneJobRuns,
  recoverAbandonedRuns,
  type JobDefinition,
} from "./runner";

/**
 * The background jobs, their cadence and limits. The scheduler calls
 * /api/jobs/tick every 5 minutes; each job runs when due, under its own
 * lease (src/server/jobs/runner.ts). Every job is idempotent: running it
 * twice, late, or after a crash is safe.
 */

export const expireHoldsJob: JobDefinition = {
  name: "expire-holds",
  everyMinutes: 5,
  staleAfterMinutes: 20,
  timeoutMs: 60_000,
  async run(db, now) {
    const expired = await expireLapsedHolds(db, null, now);
    await cancelOpenCheckouts(db, getPaymentGateway(), expired);
    return { expired: expired.length };
  },
};

export const sendNotificationsJob: JobDefinition = {
  name: "send-notifications",
  everyMinutes: 5,
  staleAfterMinutes: 20,
  timeoutMs: 120_000,
  async run(db, now) {
    const sender = getEmailSender();
    const totals = {
      sent: 0,
      suppressed: 0,
      cancelled: 0,
      retried: 0,
      failed: 0,
    };
    // Up to 5 batches of 20 per run; a larger backlog continues next tick.
    for (let batch = 0; batch < 5; batch++) {
      const r = await dispatchNotifications(db, sender, { now });
      for (const k of Object.keys(totals) as (keyof typeof totals)[])
        totals[k] += r[k];
      if (r.sent + r.suppressed + r.cancelled + r.retried + r.failed === 0)
        break;
    }
    return totals;
  },
};

/**
 * Sends queued refunds to Stripe and retries ones Stripe couldn't take
 * (same idempotency key every time, so a retry never refunds twice).
 * Without Stripe configured it does nothing; health then shows the queue.
 */
export const processRefundsJob: JobDefinition = {
  name: "process-refunds",
  everyMinutes: 5,
  staleAfterMinutes: 20,
  timeoutMs: 120_000,
  async run(db, now) {
    return processPendingRefunds(db, getPaymentGateway(), now);
  },
};

export const syncCalendarsJob: JobDefinition = {
  name: "sync-calendars",
  everyMinutes: 5,
  staleAfterMinutes: 30,
  timeoutMs: 120_000,
  async run(db, now) {
    const counts = { synced: 0, failed: 0, inProgress: 0 };
    for (const { id } of await dueSources(db, now)) {
      const outcome = await syncIcalSource(db, id, { now });
      if (outcome.ok) counts.synced++;
      else if (outcome.code === "sync_in_progress") counts.inProgress++;
      else counts.failed++;
    }
    return counts;
  },
};

export const maintenanceJob: JobDefinition = {
  name: "maintenance",
  everyMinutes: 60,
  staleAfterMinutes: 3 * 60,
  timeoutMs: 60_000,
  async run(db, now) {
    const abandoned = await recoverAbandonedRuns(db, JOBS, now);
    // Clear source leases left behind by a crashed sync.
    await db
      .update(externalCalendarSources)
      .set({ syncLeaseUntil: null })
      .where(lte(externalCalendarSources.syncLeaseUntil, now));
    // A source with no success inside its stale window shows as STALE even
    // if no sync has run (e.g. the scheduler stopped).
    await db
      .update(externalCalendarSources)
      .set({ syncStatus: "STALE" })
      .where(
        and(
          eq(externalCalendarSources.enabled, true),
          eq(externalCalendarSources.syncStatus, "OK"),
          or(
            isNull(externalCalendarSources.lastSuccessAt),
            sql`${externalCalendarSources.lastSuccessAt} < ${now.toISOString()}::timestamptz - make_interval(mins => ${externalCalendarSources.staleAfterMinutes})`,
          ),
        ),
      );
    await pruneRateLimits(db, now);
    await pruneSessions(db, now);
    await pruneJobRuns(db, now);
    const alerted = await alertOnProblems(db, now);
    return { abandonedRuns: abandoned, alerted };
  },
};

export const JOBS: readonly JobDefinition[] = [
  expireHoldsJob,
  sendNotificationsJob,
  processRefundsJob,
  syncCalendarsJob,
  maintenanceJob,
];

/**
 * Emails the owner about operational problems (backlogs, failed emails or
 * webhooks, a stalled job), once per problem set per day. A scheduler that
 * has stopped entirely can't report itself: that is what the external
 * uptime monitor on /api/health is for.
 */
async function alertOnProblems(db: Database, now: Date): Promise<boolean> {
  const health = await systemHealth(db, now);
  const problems = health.problems.filter(
    (p) => p !== "job_overdue:maintenance",
  );
  if (problems.length === 0) return false;
  const day = now.toISOString().slice(0, 10);
  await enqueueNotification(db, {
    template: "owner_system_alert",
    reservationId: null,
    idempotencyKey: `owner_system_alert:${day}:${[...problems].sort().join(",")}`,
  });
  return true;
}
