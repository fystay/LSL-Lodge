import "server-only";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  externalCalendarSources,
  jobRuns,
  notificationJobs,
  payments,
  webhookEvents,
} from "@/server/db/schema";

/**
 * Operational health, shared by the admin System page, the owner alert in
 * the maintenance job and /api/health (for an external uptime monitor).
 * Problem codes carry no personal data.
 */

/** Cadence and staleness per job; kept here so health has no import cycle. */
export const JOB_SCHEDULE = [
  { name: "expire-holds", staleAfterMinutes: 20 },
  { name: "send-notifications", staleAfterMinutes: 20 },
  { name: "process-refunds", staleAfterMinutes: 20 },
  { name: "reconcile-payments", staleAfterMinutes: 60 },
  { name: "sync-calendars", staleAfterMinutes: 30 },
  { name: "maintenance", staleAfterMinutes: 3 * 60 },
  { name: "data-retention", staleAfterMinutes: 3 * 24 * 60 },
] as const;

export interface JobStatus {
  name: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastErrorCode: string | null;
  lastSuccessAt: Date | null;
  overdue: boolean;
}

export interface SystemHealth {
  ok: boolean;
  problems: string[];
  jobs: JobStatus[];
  notificationBacklog: number;
  failedNotifications7d: number;
  failedWebhooks: number;
  staleCalendars: number;
  stuckRefunds: number;
  failedRefunds: number;
}

export async function systemHealth(
  db: Database,
  now: Date,
): Promise<SystemHealth> {
  const jobs: JobStatus[] = [];
  for (const job of JOB_SCHEDULE) {
    const [last] = await db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.name, job.name))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1);
    const [success] = await db
      .select({ at: jobRuns.finishedAt })
      .from(jobRuns)
      .where(and(eq(jobRuns.name, job.name), eq(jobRuns.status, "SUCCEEDED")))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1);
    const lastSuccessAt = success?.at ?? null;
    jobs.push({
      name: job.name,
      lastRunAt: last?.startedAt ?? null,
      lastStatus: last?.status ?? null,
      lastErrorCode: last?.errorCode ?? null,
      lastSuccessAt,
      overdue:
        !lastSuccessAt ||
        now.getTime() - lastSuccessAt.getTime() >
          job.staleAfterMinutes * 60_000,
    });
  }

  const count = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const backlog = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationJobs)
      .where(
        and(
          eq(notificationJobs.status, "PENDING"),
          lt(
            notificationJobs.nextAttemptAt,
            new Date(now.getTime() - 15 * 60_000),
          ),
        ),
      ),
  );
  const failedNotifications = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationJobs)
      .where(
        and(
          eq(notificationJobs.status, "FAILED"),
          gt(
            notificationJobs.updatedAt,
            new Date(now.getTime() - 7 * 86_400_000),
          ),
        ),
      ),
  );
  const failedWebhooks = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(eq(webhookEvents.state, "FAILED")),
  );
  const staleCalendars = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(externalCalendarSources)
      .where(
        and(
          eq(externalCalendarSources.enabled, true),
          sql`${externalCalendarSources.syncStatus} IN ('STALE', 'ERROR')`,
        ),
      ),
  );

  // Refunds queued for over an hour (Stripe unreachable or not configured),
  // or failed outright in the last 30 days.
  const stuckRefunds = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        and(
          eq(payments.kind, "REFUND"),
          sql`${payments.status} IN ('PENDING', 'REQUIRES_ACTION')`,
          lt(payments.createdAt, new Date(now.getTime() - 60 * 60_000)),
        ),
      ),
  );
  const failedRefunds = count(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        and(
          eq(payments.kind, "REFUND"),
          eq(payments.status, "FAILED"),
          gt(payments.updatedAt, new Date(now.getTime() - 30 * 86_400_000)),
        ),
      ),
  );

  const problems = [
    ...jobs.filter((j) => j.overdue).map((j) => `job_overdue:${j.name}`),
    ...(backlog > 0 ? ["notification_backlog"] : []),
    ...(failedNotifications > 0 ? ["notifications_failed"] : []),
    ...(failedWebhooks > 0 ? ["webhooks_failed"] : []),
    ...(staleCalendars > 0 ? ["calendar_sync_unhealthy"] : []),
    ...(stuckRefunds > 0 ? ["refunds_stuck"] : []),
    ...(failedRefunds > 0 ? ["refunds_failed"] : []),
  ];
  return {
    ok: problems.length === 0,
    problems,
    jobs,
    notificationBacklog: backlog,
    failedNotifications7d: failedNotifications,
    failedWebhooks,
    staleCalendars,
    stuckRefunds,
    failedRefunds,
  };
}
