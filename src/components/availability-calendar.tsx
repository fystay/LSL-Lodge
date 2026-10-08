import { addDays, isoWeekday, parseIsoDate, type IsoDate } from "@/lib/dates";
import type { NightStatus } from "@/server/booking/availability";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const statusText: Record<NightStatus, string> = {
  available: "available",
  booked: "unavailable",
  turnover: "unavailable (changeover)",
};

/**
 * Month grids showing which nights are free. Status is conveyed by text (for
 * screen readers) and a strike-through pattern (visually), never by colour
 * alone. Purely informational: dates are chosen with the search form.
 */
export function AvailabilityCalendar({
  statuses,
  months,
  highlight,
}: {
  statuses: Map<IsoDate, NightStatus>;
  months: { year: number; month: number }[];
  highlight?: { start: IsoDate; end: IsoDate };
}) {
  return (
    <div>
      <div className="grid gap-8 sm:grid-cols-2">
        {months.map(({ year, month }) => (
          <Month
            key={`${year}-${month}`}
            year={year}
            month={month}
            statuses={statuses}
            highlight={highlight}
          />
        ))}
      </div>
      <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-4 rounded-sm border border-sage-600/50 bg-ivory"
          />
          Available night
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-4 rounded-sm bg-mist line-through decoration-ink-muted"
          />
          <s>Unavailable</s>
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-4 rounded-sm bg-pine-800"
          />
          Your dates
        </span>
      </p>
    </div>
  );
}

function Month({
  year,
  month,
  statuses,
  highlight,
}: {
  year: number;
  month: number;
  statuses: Map<IsoDate, NightStatus>;
  highlight?: { start: IsoDate; end: IsoDate };
}) {
  const first = parseIsoDate(`${year}-${String(month).padStart(2, "0")}-01`);
  const title = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  const leading = isoWeekday(first) - 1;
  const days: (IsoDate | null)[] = Array.from({ length: leading }, () => null);
  for (let d = first; Number(d.slice(5, 7)) === month; d = addDays(d, 1))
    days.push(d);
  while (days.length % 7 !== 0) days.push(null);
  const weeks = Array.from({ length: days.length / 7 }, (_, i) =>
    days.slice(i * 7, i * 7 + 7),
  );

  return (
    <table className="w-full table-fixed border-collapse text-center text-sm">
      <caption className="mb-2 text-left font-display text-xl text-pine-900">
        {title}
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map((d) => (
            <th
              key={d}
              scope="col"
              className="pb-1 text-xs font-semibold text-sage-600"
            >
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, i) => (
          <tr key={i}>
            {week.map((date, j) => {
              if (!date) return <td key={j} />;
              const status = statuses.get(date);
              const chosen =
                highlight && date >= highlight.start && date < highlight.end;
              const day = Number(date.slice(8));
              if (!status) {
                return (
                  <td key={date} className="p-0.5 text-ink-muted/60">
                    {day}
                  </td>
                );
              }
              const free = status === "available";
              return (
                <td key={date} className="p-0.5">
                  <span
                    className={`flex h-9 items-center justify-center rounded-sm ${
                      chosen
                        ? "bg-pine-800 text-ivory"
                        : free
                          ? "border border-sage-600/40 bg-ivory text-ink"
                          : "bg-mist text-ink-muted line-through"
                    }`}
                  >
                    {day}
                    <span className="sr-only">
                      {`, night of ${date}: ${statusText[status]}${chosen ? ", your dates" : ""}`}
                    </span>
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two months to show for a search (or from today). */
export function monthsFrom(date: IsoDate, count = 2) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const m = month - 1 + i;
    return { year: year + Math.floor(m / 12), month: (m % 12) + 1 };
  });
}
