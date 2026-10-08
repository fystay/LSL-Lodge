import Link from "next/link";
import { Suspense } from "react";
import { NotReady, smallButton } from "@/components/admin-ui";
import {
  addDays,
  isoWeekday,
  parseIsoDate,
  startOfMonth,
  type IsoDate,
} from "@/lib/dates";
import { adminContext } from "@/server/admin/context";
import {
  loadBlocks,
  type Block,
  type BlockSource,
} from "@/server/booking/availability";

export const metadata = { title: "Calendar" };

const SOURCE_LABEL: Record<BlockSource, string> = {
  DIRECT_BOOKING: "Direct booking",
  HOLD: "Hold",
  OWNER_BLOCK: "Owner block",
  AIRBNB_ICAL: "Airbnb",
  GOOGLE: "Google",
  OTHER_ICAL: "Other calendar",
  CHANNEL_MANAGER: "Channel manager",
};

const SOURCE_STYLE: Record<BlockSource, string> = {
  DIRECT_BOOKING: "bg-pine-800 text-ivory",
  HOLD: "border border-dashed border-pine-800 text-pine-900",
  OWNER_BLOCK: "bg-wood-200 text-pine-950",
  AIRBNB_ICAL: "bg-notice text-notice-ink",
  GOOGLE: "bg-mist text-ink",
  OTHER_ICAL: "bg-mist text-ink",
  CHANNEL_MANAGER: "bg-mist text-ink",
};

export default function CalendarPage({
  searchParams,
}: PageProps<"/admin/calendar">) {
  return (
    <>
      <h1 className="text-title">Calendar</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <AdminCalendar searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function AdminCalendar({
  searchParams,
}: {
  searchParams: PageProps<"/admin/calendar">["searchParams"];
}) {
  const { month } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );

  const start =
    typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? parseIsoDate(`${month}-01`)
      : startOfMonth(ctx.today);
  const nextMonth = startOfMonth(addDays(start, 32));
  const prevMonth = startOfMonth(addDays(start, -1));
  const blocks = await loadBlocks(
    ctx.db,
    ctx.property.id,
    { start, end: nextMonth },
    0,
    ctx.now,
  );
  const title = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${start}T00:00:00Z`));

  const days: (IsoDate | null)[] = Array.from(
    { length: isoWeekday(start) - 1 },
    () => null,
  );
  for (let d = start; d < nextMonth; d = addDays(d, 1)) days.push(d);
  while (days.length % 7) days.push(null);

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          className={smallButton}
          href={`/admin/calendar?month=${prevMonth.slice(0, 7)}`}
        >
          Previous month
        </Link>
        <h2 className="text-2xl" aria-live="polite">
          {title}
        </h2>
        <Link
          className={smallButton}
          href={`/admin/calendar?month=${nextMonth.slice(0, 7)}`}
        >
          Next month
        </Link>
      </div>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Calendar (scrolls sideways on small screens)"
      >
        <table className="w-full min-w-[44rem] table-fixed border-collapse text-sm">
          <caption className="sr-only">
            Nights in {title} and what occupies them
          </caption>
          <thead>
            <tr>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="pb-1 text-left text-xs text-sage-600"
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: days.length / 7 }, (_, w) => (
              <tr key={w}>
                {days.slice(w * 7, w * 7 + 7).map((date, i) => (
                  <td
                    key={date ?? `e${i}`}
                    className="h-24 border border-sage-300/70 p-1 align-top"
                  >
                    {date && <Night date={date} blocks={blocks} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-ink-muted">
        Each label shows where a night&rsquo;s block came from. Overlapping
        labels on a night mean a conflict to resolve.
      </p>
    </div>
  );
}

function Night({ date, blocks }: { date: IsoDate; blocks: Block[] }) {
  const here = blocks.filter((b) => b.start <= date && date < b.end);
  return (
    <div>
      <span className="font-semibold">{Number(date.slice(8))}</span>
      {here.length === 0 && <span className="sr-only"> free</span>}
      <ul className="mt-1 space-y-0.5">
        {here.map((b) => (
          <li
            key={`${b.source}-${b.id}`}
            className={`truncate rounded-sm px-1 text-xs ${SOURCE_STYLE[b.source]}`}
          >
            {SOURCE_LABEL[b.source]}
          </li>
        ))}
      </ul>
      {here.length > 1 && (
        <p className="mt-0.5 text-xs font-semibold text-danger">Conflict</p>
      )}
    </div>
  );
}
