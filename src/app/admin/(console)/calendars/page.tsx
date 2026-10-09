import Link from "next/link";
import { Suspense } from "react";
import {
  AdminSection,
  Field,
  FormStatus,
  NotReady,
  inputClass,
  primaryButton,
  smallButton,
  statusLabel,
} from "@/components/admin-ui";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { siteUrl } from "@/lib/site";
import { adminContext } from "@/server/admin/context";
import { calendarConflicts, calendarSources } from "@/server/admin/data";
import { calendarExportSecret, exportToken } from "@/server/calendar/export";
import { isStale } from "@/server/calendar/sync";
import {
  addCalendarSourceAction,
  syncCalendarSourceAction,
  toggleCalendarSourceAction,
} from "../../actions";

export const metadata = { title: "Calendar sync" };

const ERROR_TEXT: Record<string, string> = {
  timeout: "Airbnb didn’t respond in time",
  held_removals: "Removals held for your review",
  not_icalendar: "The link didn’t return a calendar",
  parse_not_icalendar: "The link didn’t return a calendar",
  credential_unreadable:
    "Stored link can’t be decrypted (encryption key changed?)",
  not_configured: "No link stored",
};

export default function CalendarsPage({
  searchParams,
}: PageProps<"/admin/calendars">) {
  return (
    <>
      <h1 className="text-title">Calendar sync</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Calendars searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Calendars({
  searchParams,
}: {
  searchParams: PageProps<"/admin/calendars">["searchParams"];
}) {
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const [sources, conflicts] = await Promise.all([
    calendarSources(ctx.db, ctx.property.id),
    calendarConflicts(ctx.db, ctx.property.id),
  ]);
  const when = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: ctx.property.timeZone,
        }).format(d)
      : "never";
  const exportSecret = calendarExportSecret();
  const imports = sources.filter((s) => s.direction === "IMPORT");

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        saved={typeof saved === "string" ? saved : undefined}
        error={typeof error === "string" ? error : undefined}
      />
      <p className="max-w-3xl">
        Airbnb shares its calendar as a link that we check regularly (every 5 to
        15 minutes when scheduled jobs run). Airbnb updates that link on its own
        schedule, so{" "}
        <strong>
          a booking made on Airbnb can take a while to appear here
        </strong>
        , and the reverse. Imported dates block the website until Airbnb removes
        them. If a sync fails, the last imported dates stay blocked.
      </p>

      {conflicts.length > 0 && (
        <AdminSection id="conflicts" title="Clashes to resolve">
          <p className="text-danger">
            These website requests or bookings overlap dates an imported
            calendar shows as busy. Nothing has been changed automatically.
          </p>
          <ul className="mt-3 divide-y divide-sage-300/70">
            {conflicts.map((c) => (
              <li
                key={`${c.reservationId}-${c.busyStart}`}
                className="flex flex-wrap gap-3 py-2"
              >
                <Link
                  href={`/admin/bookings/${c.reservationId}`}
                  className="font-semibold underline underline-offset-4"
                >
                  {c.publicRef}
                </Link>
                <span>
                  {formatStayDate(c.checkIn as IsoDate)} –{" "}
                  {formatStayDate(c.checkOut as IsoDate)} ·{" "}
                  {statusLabel(c.status)}
                </span>
                <span>
                  overlaps {c.source}: {formatStayDate(c.busyStart as IsoDate)}{" "}
                  – {formatStayDate(c.busyEnd as IsoDate)}
                </span>
              </li>
            ))}
          </ul>
        </AdminSection>
      )}

      <AdminSection id="imports" title="Imported calendars">
        {imports.length === 0 ? (
          <p>No calendars imported yet.</p>
        ) : (
          <ul className="space-y-5">
            {imports.map((s) => {
              const stale = s.enabled && isStale(s, ctx.now);
              const held = s.lastErrorCode === "held_removals";
              return (
                <li
                  key={s.id}
                  className="rounded-soft border border-sage-300 p-4"
                >
                  <p className="text-lg font-semibold">
                    {s.label}{" "}
                    <span className="text-sm font-normal">
                      ({s.enabled ? "syncing" : "paused"})
                    </span>
                  </p>
                  <dl className="mt-2 grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
                    <dt className="font-semibold">Health</dt>
                    <dd
                      className={
                        stale || s.syncStatus === "ERROR"
                          ? "font-semibold text-danger"
                          : undefined
                      }
                    >
                      {stale
                        ? "Out of date: dates booked elsewhere may be missing"
                        : s.syncStatus === "OK"
                          ? "Working"
                          : s.syncStatus.replaceAll("_", " ").toLowerCase()}
                    </dd>
                    <dt className="font-semibold">Last successful sync</dt>
                    <dd>{when(s.lastSuccessAt)}</dd>
                    <dt className="font-semibold">Last attempt</dt>
                    <dd>{when(s.lastAttemptAt)}</dd>
                    <dt className="font-semibold">Busy periods imported</dt>
                    <dd>{s.activePeriods}</dd>
                    {s.lastErrorCode && (
                      <>
                        <dt className="font-semibold">Last problem</dt>
                        <dd>
                          {ERROR_TEXT[s.lastErrorCode] ?? s.lastErrorCode}
                          {s.consecutiveFailures > 0
                            ? ` (${s.consecutiveFailures} failed attempts in a row)`
                            : ""}
                          {s.lastErrorMessage ? `. ${s.lastErrorMessage}` : ""}
                        </dd>
                      </>
                    )}
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <form action={syncCalendarSourceAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button type="submit" className={smallButton}>
                        Sync now
                      </button>
                    </form>
                    <form action={toggleCalendarSourceAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={s.enabled ? "false" : "true"}
                      />
                      <button type="submit" className={smallButton}>
                        {s.enabled ? "Pause syncing" : "Resume syncing"}
                      </button>
                    </form>
                  </div>
                  {held && (
                    <form
                      action={syncCalendarSourceAction}
                      className="mt-3 rounded-soft border border-notice-ink/30 bg-notice p-3 text-notice-ink"
                    >
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="intent" value="release" />
                      <p>
                        The feed suddenly stopped listing upcoming busy dates.
                        This is often a temporary Airbnb glitch, so those dates
                        are still blocked. Check your Airbnb calendar first.
                      </p>
                      <label className="mt-2 flex min-h-11 items-center gap-3">
                        <input
                          type="checkbox"
                          name="releaseHeld"
                          value="yes"
                          className="size-5"
                        />
                        <span>
                          Airbnb really has no bookings there: release them
                        </span>
                      </label>
                      <button type="submit" className={smallButton}>
                        Release held dates
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </AdminSection>

      <AdminSection id="add" title="Add an Airbnb calendar">
        <p className="mb-3 text-sm text-ink-muted">
          In Airbnb: Calendar → Availability → Connect calendars → Export
          calendar, then copy the link. Paste it here only: the link gives read
          access to your Airbnb calendar, so it is stored encrypted and never
          shown again.
        </p>
        <form
          action={addCalendarSourceAction}
          className="grid gap-4 sm:grid-cols-[1fr_2fr]"
        >
          <Field label="Name" name="label">
            <input
              id="label"
              name="label"
              defaultValue="Airbnb"
              maxLength={80}
              className={inputClass}
            />
          </Field>
          <Field label="Airbnb export link" name="url">
            <input
              id="url"
              name="url"
              type="url"
              required
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-2">
            <button type="submit" className={primaryButton}>
              Add calendar
            </button>
          </div>
        </form>
      </AdminSection>

      <AdminSection id="export" title="Show website bookings on Airbnb">
        {exportSecret ? (
          <>
            <p>
              In Airbnb: Calendar → Availability → Connect calendars → Import
              calendar, and paste this link. It lists website bookings, pending
              requests and your blocked dates as &ldquo;Not available&rdquo;,
              with no guest details. Airbnb reads it on its own schedule.
            </p>
            <p className="mt-3 rounded-soft bg-mist p-3 font-mono text-sm break-all">
              {siteUrl}/calendar/{exportToken(exportSecret, ctx.property.id)}
              .ics
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              Treat this link as private. To revoke it, change
              CALENDAR_EXPORT_SECRET; the link changes too.
            </p>
          </>
        ) : (
          <p>
            The export link isn&rsquo;t set up: CALENDAR_EXPORT_SECRET needs to
            be configured on the server.
          </p>
        )}
      </AdminSection>

      <AdminSection id="google" title="Google Calendar">
        <p>
          Not connected. Google Calendar sync needs a Google Cloud project and
          your approval of the account and calendars to use; until then, block
          dates by hand under{" "}
          <Link href="/admin/blocks" className="underline underline-offset-4">
            Blocked dates
          </Link>
          .
        </p>
      </AdminSection>
    </div>
  );
}
