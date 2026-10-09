import Link from "next/link";
import { Suspense } from "react";
import {
  AdminSection,
  FormStatus,
  NotReady,
  statusLabel,
} from "@/components/admin-ui";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { adminContext } from "@/server/admin/context";
import { isStale } from "@/server/calendar/sync";
import {
  calendarSources,
  pendingRequests,
  recentAudit,
  reviewQueue,
  upcomingStays,
} from "@/server/admin/data";

export const metadata = { title: "Overview" };

export default function OverviewPage({ searchParams }: PageProps<"/admin">) {
  return (
    <>
      <h1 className="text-title">Overview</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Overview searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Overview({
  searchParams,
}: {
  searchParams: PageProps<"/admin">["searchParams"];
}) {
  const { error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const [requests, review, stays, sources, audit] = await Promise.all([
    pendingRequests(ctx.db, ctx.property.id),
    reviewQueue(ctx.db, ctx.property.id),
    upcomingStays(ctx.db, ctx.property.id, ctx.today),
    calendarSources(ctx.db, ctx.property.id),
    recentAudit(ctx.db, 15),
  ]);
  const deadline = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: ctx.property.timeZone,
        }).format(d)
      : "—";

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        error={
          error === "forbidden"
            ? "Your account has read-only access, so that change wasn’t made."
            : typeof error === "string"
              ? error
              : undefined
        }
      />
      {ctx.admin.role === "VIEWER" && (
        <p
          role="status"
          className="rounded-soft border border-sage-300 bg-sage-100 p-3"
        >
          You have read-only access. Changes can only be made by the owner.
        </p>
      )}
      <p>
        Signed in as <strong>{ctx.admin.email}</strong>. Online bookings are{" "}
        <strong>
          {ctx.property.bookingsEnabled ? "switched on" : "switched off"}
        </strong>{" "}
        for this property.
      </p>

      <AdminSection id="requests" title="Requests awaiting your decision">
        {requests.length === 0 ? (
          <p>No requests waiting.</p>
        ) : (
          <ul className="divide-y divide-sage-300/70">
            {requests.map((q) => (
              <li
                key={q.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-3"
              >
                <Link
                  href={`/admin/bookings/${q.id}`}
                  className="font-semibold text-pine-800 underline underline-offset-4"
                >
                  {q.publicRef}
                </Link>
                <span>
                  {formatStayDate(q.checkIn as IsoDate)} –{" "}
                  {formatStayDate(q.checkOut as IsoDate)} · {q.guests} guests ·{" "}
                  {q.guestName}
                </span>
                <span className="tabular-nums">
                  {formatMoney(q.totalMinor, q.currency)}
                </span>
                <span>
                  Respond by <strong>{deadline(q.holdExpiresAt)}</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      {review.length > 0 && (
        <AdminSection id="review" title="Needs your attention">
          <ul className="divide-y divide-sage-300/70">
            {review.map((q) => (
              <li key={q.id} className="flex flex-wrap gap-3 py-3">
                <Link
                  href={`/admin/bookings/${q.id}`}
                  className="font-semibold text-pine-800 underline underline-offset-4"
                >
                  {q.publicRef}
                </Link>
                <span>
                  {formatStayDate(q.checkIn as IsoDate)} –{" "}
                  {formatStayDate(q.checkOut as IsoDate)}
                </span>
                <span>{statusLabel(q.status)}</span>
                <span className="font-semibold text-danger">
                  {(q.reviewReason ?? "").replaceAll("_", " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </AdminSection>
      )}

      <AdminSection id="upcoming" title="Upcoming stays, requests and holds">
        {stays.length === 0 ? (
          <p>No upcoming stays.</p>
        ) : (
          <ul className="divide-y divide-sage-300/70">
            {stays.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-3"
              >
                <Link
                  href={`/admin/bookings/${s.id}`}
                  className="font-semibold text-pine-800 underline underline-offset-4"
                >
                  {s.publicRef}
                </Link>
                <span>
                  {formatStayDate(s.checkIn as IsoDate)} –{" "}
                  {formatStayDate(s.checkOut as IsoDate)} · {s.guests} guests
                </span>
                <span>{statusLabel(s.status)}</span>
                <span className="tabular-nums">
                  {formatMoney(s.totalMinor, s.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection id="sync" title="Calendar connections">
        {sources.length === 0 ? (
          <p>
            No external calendars are connected yet. Add your Airbnb calendar
            under{" "}
            <Link
              href="/admin/calendars"
              className="underline underline-offset-4"
            >
              Calendar sync
            </Link>
            ; until then, block dates booked elsewhere by hand under{" "}
            <Link href="/admin/blocks" className="underline underline-offset-4">
              Blocked dates
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-sage-300/70">
            {sources.map((s) => (
              <li key={s.id} className="py-3">
                <strong>{s.label}</strong> ({s.provider},{" "}
                {s.direction.toLowerCase()}) —{" "}
                {s.enabled && isStale(s, ctx.now)
                  ? "out of date"
                  : s.syncStatus.replaceAll("_", " ").toLowerCase()}
                {s.lastSuccessAt
                  ? `, last success ${s.lastSuccessAt.toISOString()}`
                  : ", never synced"}
                {s.lastErrorCode ? ` · last error: ${s.lastErrorCode}` : ""}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection id="activity" title="Recent activity">
        {audit.length === 0 ? (
          <p>Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id}>
                <time dateTime={a.createdAt.toISOString()}>
                  {a.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                </time>{" "}
                · {a.action} · {a.actorType.toLowerCase()}
                {a.actorId ? ` (${a.actorId})` : ""}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
    </div>
  );
}
