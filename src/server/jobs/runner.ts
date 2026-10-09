import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { jobLeases, jobRuns } from "@/server/db/schema";

/**
 * Runs a background job at most once at a time, with a durable record.
 *
 * - Lease: a row per job name. A run starts only if it can take the lease
 *   (free, or expired). Overlapping triggers (scheduler retries, a manual
 *   run, two schedulers) are skipped, not run twice. A runner that crashes
 *   leaves the lease to expire after `leaseSeconds`.
 * - Run log: RUNNING → SUCCEEDED/FAILED, with duration, counts and an error
 *   code (never personal data). Runs left RUNNING by a crash are marked
 *   FAILED ("ABANDONED") by recoverAbandonedRuns.
 * - Timeout: a run that exceeds `timeoutMs` is recorded FAILED ("TIMEOUT").
 *   Its lease is kept until expiry, because the work may still be finishing;
 *   jobs are idempotent, so the next run safely continues.
 */

export interface JobDefinition {
  name: string;
  /** How often the tick should run it. */
  everyMinutes: number;
  /** Health turns red if no success for this long. */
  staleAfterMinutes: number;
  timeoutMs: number;
  run: (db: Database, now: Date) => Promise<Record<string, unknown>>;
}

export type RunOutcome =
  | { status: "SUCCEEDED"; summary: Record<string, unknown> }
  | { status: "FAILED"; errorCode: string }
  | { status: "SKIPPED"; reason: "LEASE_HELD" };

const leaseSeconds = (job: JobDefinition) =>
  Math.ceil(job.timeoutMs / 1000) + 60;

export async function acquireLease(
  db: Database,
  name: string,
  holder: string,
  until: Date,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .insert(jobLeases)
    .values({ name, holder, leasedUntil: until })
    .onConflictDoUpdate({
      target: jobLeases.name,
      set: { holder, leasedUntil: until },
      setWhere: lt(jobLeases.leasedUntil, now),
    })
    .returning({ holder: jobLeases.holder });
  return rows[0]?.holder === holder;
}

/** Releases by expiring the lease outright (independent of any clock). */
async function releaseLease(db: Database, name: string, holder: string) {
  await db
    .update(jobLeases)
    .set({ leasedUntil: new Date(0) })
    .where(and(eq(jobLeases.name, name), eq(jobLeases.holder, holder)));
}

class JobTimeoutError extends Error {
  constructor() {
    super("Job timed out");
    this.name = "JobTimeoutError";
  }
}

function errorCode(error: unknown): string {
  if (error instanceof JobTimeoutError) return "TIMEOUT";
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 60);
  return error instanceof Error ? error.name.slice(0, 60) : "UNKNOWN";
}

export async function runJob(
  db: Database,
  job: JobDefinition,
  now = new Date(),
): Promise<RunOutcome> {
  const holder = randomUUID();
  const leased = await acquireLease(
    db,
    job.name,
    holder,
    new Date(now.getTime() + leaseSeconds(job) * 1000),
    now,
  );
  if (!leased) return { status: "SKIPPED", reason: "LEASE_HELD" };

  const [run] = await db
    .insert(jobRuns)
    .values({ name: job.name, status: "RUNNING", startedAt: now })
    .returning({ id: jobRuns.id });
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const summary = await Promise.race([
      job.run(db, now),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeoutError()), job.timeoutMs);
      }),
    ]);
    await db
      .update(jobRuns)
      .set({
        status: "SUCCEEDED",
        finishedAt: new Date(now.getTime() + (Date.now() - started)),
        durationMs: Date.now() - started,
        summary,
      })
      .where(eq(jobRuns.id, run.id));
    await releaseLease(db, job.name, holder);
    return { status: "SUCCEEDED", summary };
  } catch (error) {
    const code = errorCode(error);
    await db
      .update(jobRuns)
      .set({
        status: "FAILED",
        finishedAt: new Date(now.getTime() + (Date.now() - started)),
        durationMs: Date.now() - started,
        errorCode: code,
      })
      .where(eq(jobRuns.id, run.id));
    // After a timeout the work may still be running: keep the lease.
    if (code !== "TIMEOUT") await releaseLease(db, job.name, holder);
    console.error("job.failed", { job: job.name, code });
    return { status: "FAILED", errorCode: code };
  } finally {
    clearTimeout(timer);
  }
}

/** Marks runs left RUNNING past any possible lease as FAILED ("ABANDONED"). */
export async function recoverAbandonedRuns(
  db: Database,
  jobs: readonly JobDefinition[],
  now: Date,
): Promise<number> {
  let recovered = 0;
  for (const job of jobs) {
    const cutoff = new Date(now.getTime() - leaseSeconds(job) * 1000);
    const rows = await db
      .update(jobRuns)
      .set({ status: "FAILED", errorCode: "ABANDONED", finishedAt: now })
      .where(
        and(
          eq(jobRuns.name, job.name),
          eq(jobRuns.status, "RUNNING"),
          lt(jobRuns.startedAt, cutoff),
        ),
      )
      .returning({ id: jobRuns.id });
    recovered += rows.length;
  }
  return recovered;
}

/** Whether a job is due, based on its last started run. */
export async function isDue(db: Database, job: JobDefinition, now: Date) {
  const [last] = await db
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(eq(jobRuns.name, job.name))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  // A minute of slack so a 5-minute tick reliably runs a 5-minute job.
  return (
    !last ||
    now.getTime() - last.startedAt.getTime() >= (job.everyMinutes - 1) * 60_000
  );
}

/** Deletes run history older than `days`. */
export async function pruneJobRuns(db: Database, now: Date, days = 30) {
  await db
    .delete(jobRuns)
    .where(
      sql`${jobRuns.startedAt} < ${new Date(now.getTime() - days * 86_400_000).toISOString()}::timestamptz`,
    );
}
