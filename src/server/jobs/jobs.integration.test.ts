import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  externalCalendarSources,
  jobLeases,
  jobRuns,
  notificationJobs,
} from "@/server/db/schema";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { syncIcalSource } from "@/server/calendar/sync";
import { JOBS, maintenanceJob } from "./definitions";
import { JOB_SCHEDULE, systemHealth } from "./health";
import {
  acquireLease,
  isDue,
  recoverAbandonedRuns,
  runJob,
  type JobDefinition,
} from "./runner";

const db = testDatabase(20);
afterAll(async () => db.$client.end());
beforeEach(async () => {
  await resetTables(db);
  await db.delete(jobRuns);
  await db.delete(jobLeases);
});

const T0 = new Date("2026-10-09T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: "test-job",
    everyMinutes: 5,
    staleAfterMinutes: 20,
    timeoutMs: 5_000,
    run: async () => ({ done: 1 }),
    ...overrides,
  };
}

const runs = () => db.select().from(jobRuns);

describe("runJob", () => {
  it("records a successful run and releases the lease", async () => {
    expect(await runJob(db, job(), T0)).toEqual({
      status: "SUCCEEDED",
      summary: { done: 1 },
    });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "SUCCEEDED", summary: { done: 1 } });
    expect(await runJob(db, job(), at(MIN))).toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("never runs the same job twice at once", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = job({
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(200);
        concurrent--;
        return {};
      },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => runJob(db, slow, T0)),
    );
    expect(outcomes.filter((o) => o.status === "SUCCEEDED")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "SKIPPED")).toHaveLength(5);
    expect(maxConcurrent).toBe(1);
  });

  it("skips while a crashed runner's lease is live, and runs once it expires", async () => {
    await acquireLease(db, "test-job", "crashed-runner", at(2 * MIN), T0);
    expect(await runJob(db, job(), at(MIN))).toEqual({
      status: "SKIPPED",
      reason: "LEASE_HELD",
    });
    expect(await runJob(db, job(), at(3 * MIN))).toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("records failures with a code and lets the next run proceed", async () => {
    const failing = job({
      run: async () => {
        throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
      },
    });
    expect(await runJob(db, failing, T0)).toEqual({
      status: "FAILED",
      errorCode: "ECONNRESET",
    });
    expect(await runJob(db, job(), at(MIN))).toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("times out, records it, and keeps the lease while the work may still run", async () => {
    const hanging = job({ timeoutMs: 50, run: () => new Promise(() => {}) });
    expect(await runJob(db, hanging, new Date())).toEqual({
      status: "FAILED",
      errorCode: "TIMEOUT",
    });
    expect(await runJob(db, job(), new Date())).toMatchObject({
      status: "SKIPPED",
    });
  });

  it("marks runs abandoned by a crash as failed", async () => {
    await db.insert(jobRuns).values({
      name: "test-job",
      status: "RUNNING",
      startedAt: T0,
    });
    expect(await recoverAbandonedRuns(db, [job()], at(MIN))).toBe(0);
    expect(await recoverAbandonedRuns(db, [job()], at(10 * MIN))).toBe(1);
    expect((await runs())[0]).toMatchObject({
      status: "FAILED",
      errorCode: "ABANDONED",
    });
  });

  it("is due only after its interval", async () => {
    const j = job();
    expect(await isDue(db, j, T0)).toBe(true);
    await runJob(db, j, T0);
    expect(await isDue(db, j, at(2 * MIN))).toBe(false);
    expect(await isDue(db, j, at(4 * MIN))).toBe(true);
  });
});

describe("health", () => {
  it("knows every job's schedule", () => {
    expect(JOBS.map((j) => [j.name, j.staleAfterMinutes])).toEqual(
      JOB_SCHEDULE.map((j) => [j.name, j.staleAfterMinutes]),
    );
  });

  it("reports jobs as overdue until they succeed, and flags backlogs", async () => {
    const before = await systemHealth(db, T0);
    expect(before.ok).toBe(false);
    expect(before.problems).toEqual(JOBS.map((j) => `job_overdue:${j.name}`));

    for (const j of JOBS)
      await db.insert(jobRuns).values({
        name: j.name,
        status: "SUCCEEDED",
        startedAt: T0,
        finishedAt: T0,
      });
    expect(await systemHealth(db, at(MIN))).toMatchObject({
      ok: true,
      problems: [],
    });

    await db.insert(notificationJobs).values({
      template: "owner_system_alert",
      recipientKind: "OWNER",
      idempotencyKey: "test-backlog",
      nextAttemptAt: T0,
    });
    expect((await systemHealth(db, at(16 * MIN))).problems).toEqual([
      "notification_backlog",
    ]);
    // An hour later the email and calendar jobs are overdue too.
    expect((await systemHealth(db, at(61 * MIN))).problems).toEqual(
      expect.arrayContaining([
        "job_overdue:send-notifications",
        "notification_backlog",
      ]),
    );
  });

  it("maintenance alerts the owner about problems once per day", async () => {
    await db.insert(notificationJobs).values({
      template: "owner_system_alert",
      recipientKind: "OWNER",
      idempotencyKey: "seed-backlog",
      nextAttemptAt: at(-60 * MIN),
    });
    await runJob(db, maintenanceJob, T0);
    await db.delete(jobLeases);
    await runJob(db, maintenanceJob, at(61 * MIN));
    const alerts = (await db.select().from(notificationJobs)).filter((n) =>
      n.idempotencyKey.startsWith("owner_system_alert:"),
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(alerts.map((a) => a.idempotencyKey)).size).toBe(
      alerts.length,
    );
  });
});

describe("calendar source lease", () => {
  it("lets only one sync of a source run at a time", async () => {
    const property = await createBookableProperty(db);
    const [source] = await db
      .insert(externalCalendarSources)
      .values({
        propertyId: property.id,
        provider: "AIRBNB_ICAL",
        direction: "IMPORT",
        label: "Airbnb",
      })
      .returning();
    await db
      .update(externalCalendarSources)
      .set({ syncLeaseUntil: at(MIN) })
      .where(eq(externalCalendarSources.id, source.id));
    expect(await syncIcalSource(db, source.id, { now: T0 })).toEqual({
      ok: false,
      code: "sync_in_progress",
    });
    // After the lease lapses it runs (and fails here only because no link is stored).
    expect(await syncIcalSource(db, source.id, { now: at(2 * MIN) })).toEqual({
      ok: false,
      code: "not_configured",
    });
    const [row] = await db
      .select()
      .from(externalCalendarSources)
      .where(eq(externalCalendarSources.id, source.id));
    expect(row.syncLeaseUntil).toBeNull();
  });
});
