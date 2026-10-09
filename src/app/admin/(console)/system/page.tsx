import { Suspense } from "react";
import {
  AdminSection,
  FormStatus,
  NotReady,
  smallButton,
} from "@/components/admin-ui";
import { adminContext } from "@/server/admin/context";
import { systemHealth } from "@/server/jobs/health";
import { runJobNowAction } from "../../actions";

export const metadata = { title: "System" };

const JOB_LABEL: Record<string, string> = {
  "expire-holds": "Release lapsed requests and holds",
  "send-notifications": "Send emails",
  "sync-calendars": "Sync imported calendars",
  maintenance: "Housekeeping and health checks",
};

const PROBLEM_TEXT: Record<string, string> = {
  notification_backlog: "Emails are waiting longer than 15 minutes to send.",
  notifications_failed:
    "Some emails failed in the last 7 days (see each booking's Messages).",
  webhooks_failed:
    "Some Stripe notifications failed to process; Stripe will retry them.",
  calendar_sync_unhealthy: "An imported calendar is failing or out of date.",
};

export default function SystemPage({
  searchParams,
}: PageProps<"/admin/system">) {
  return (
    <>
      <h1 className="text-title">System</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <System searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function System({
  searchParams,
}: {
  searchParams: PageProps<"/admin/system">["searchParams"];
}) {
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const health = await systemHealth(ctx.db, ctx.now);
  const when = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: ctx.property.timeZone,
        }).format(d)
      : "never";

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        saved={typeof saved === "string" ? saved : undefined}
        error={typeof error === "string" ? error : undefined}
      />
      <AdminSection id="health" title="Health">
        {health.ok ? (
          <p className="font-semibold text-success">
            Everything is running normally.
          </p>
        ) : (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-danger">
            {health.problems.map((p) => (
              <li key={p}>
                {p.startsWith("job_overdue:")
                  ? `“${JOB_LABEL[p.slice(12)] ?? p.slice(12)}” hasn’t completed recently. Is the scheduler running?`
                  : (PROBLEM_TEXT[p] ?? p)}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-ink-muted">
          Background work runs when the scheduler calls the site every 5
          minutes. If nothing has run, the scheduler isn&rsquo;t set up or has
          stopped; you can run each task by hand below in the meantime.
        </p>
      </AdminSection>
      <AdminSection id="jobs" title="Background tasks">
        <ul className="divide-y divide-sage-300/70">
          {health.jobs.map((j) => (
            <li
              key={j.name}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="font-semibold">{JOB_LABEL[j.name] ?? j.name}</p>
                <p className="text-sm">
                  Last run: {when(j.lastRunAt)}
                  {j.lastStatus
                    ? ` (${j.lastStatus.toLowerCase()}${j.lastErrorCode ? `: ${j.lastErrorCode}` : ""})`
                    : ""}
                  {" · "}Last success: {when(j.lastSuccessAt)}
                  {j.overdue ? " · overdue" : ""}
                </p>
              </div>
              <form action={runJobNowAction}>
                <input type="hidden" name="job" value={j.name} />
                <button type="submit" className={smallButton}>
                  Run now
                </button>
              </form>
            </li>
          ))}
        </ul>
      </AdminSection>
    </div>
  );
}
