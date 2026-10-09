import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSearch } from "@/components/booking-search";
import { Container, PageHeader } from "@/components/ui";
import { searchLimits } from "@/content/property";
import {
  AvailabilityCalendar,
  monthsFrom,
} from "@/components/availability-calendar";
import { QuoteSummary } from "@/components/quote-summary";
import {
  formatStayDate,
  startOfMonth,
  todayInTimeZone,
  type IsoDate,
} from "@/lib/dates";
import { pageMetadata } from "@/lib/metadata";
import { validateStaySearch } from "@/lib/stay-search";
import {
  calendarStatuses,
  checkStay,
  calendarSyncDelayed,
  getBookingContext,
  type BookingContext,
} from "@/server/booking/public";
import { describeQuoteError } from "@/server/pricing/quote";

export const metadata = {
  ...pageMetadata(
    "/availability",
    "Availability",
    "Search dates for Lodge on the Lake.",
  ),
  // Search result URLs are not useful in search engines.
  robots: { index: false, follow: true },
};

const TIME_ZONE = "Europe/London";

export default function AvailabilityPage({
  searchParams,
}: PageProps<"/availability">) {
  return (
    <>
      <PageHeader eyebrow="Book direct" title="Availability" />
      <Container className="py-12 sm:py-14">
        <Suspense fallback={<SearchSkeleton />}>
          <Results searchParams={searchParams} />
        </Suspense>
      </Container>
    </>
  );
}

async function Results({
  searchParams,
}: {
  searchParams: PageProps<"/availability">["searchParams"];
}) {
  const params = await searchParams;
  await connection();
  const now = new Date();
  const today = todayInTimeZone(TIME_ZONE, now);
  const ctx = await getBookingContext();
  // With the booking engine on, the database's property settings are authoritative.
  const limits = ctx
    ? {
        ...searchLimits,
        maxGuests: ctx.property.maxGuests,
        minNights: ctx.property.defaultMinNights,
        horizonDays: ctx.property.bookingHorizonDays,
      }
    : searchLimits;
  const result = validateStaySearch(params, limits, today);

  const form = (
    <BookingSearch
      key={JSON.stringify(params)}
      variant="inline"
      maxGuests={limits.maxGuests}
      minNights={limits.minNights}
      timeZone={TIME_ZONE}
      defaults={
        result.status === "invalid"
          ? result.input
          : result.status === "valid"
            ? {
                checkIn: result.search.checkIn,
                checkOut: result.search.checkOut,
                guests: String(result.search.guests),
              }
            : {}
      }
      errors={result.status === "invalid" ? result.errors : []}
    />
  );

  return (
    <div className="space-y-10">
      {result.status === "invalid" && (
        <div
          role="alert"
          className="rounded-soft border border-danger/40 bg-ivory p-4"
        >
          <p className="font-semibold text-danger">Please check your search:</p>
          <ul className="mt-2 list-disc pl-5">
            {result.errors.map((e) => (
              <li key={e.field}>{e.message}</li>
            ))}
          </ul>
        </div>
      )}

      {form}

      {result.status === "valid" && (
        <section
          aria-labelledby="result-title"
          aria-live="polite"
          className="rounded-soft border border-sage-300 bg-limestone/60 p-6 sm:p-8"
        >
          <h2 id="result-title" className="text-2xl">
            {formatStayDate(result.search.checkIn)} –{" "}
            {formatStayDate(result.search.checkOut)}
          </h2>
          <p className="mt-1 text-ink-muted">
            {result.search.nights} nights · {result.search.guests}{" "}
            {result.search.guests === 1 ? "guest" : "guests"}
          </p>
          {ctx ? (
            <StayResult
              ctx={ctx}
              search={result.search}
              today={today}
              now={now}
            />
          ) : (
            <div className="mt-5 max-w-2xl space-y-3">
              <p className="font-semibold text-pine-900">
                Online booking isn&rsquo;t open yet.
              </p>
              <p>
                We can&rsquo;t show live availability or prices for these dates
                yet, and nothing has been reserved. If you&rsquo;d like to stay,
                please{" "}
                <Link
                  href="/contact"
                  className="font-semibold text-pine-800 underline underline-offset-4"
                >
                  contact the owner
                </Link>
                .
              </p>
            </div>
          )}
        </section>
      )}

      {ctx && (
        <section aria-labelledby="calendar-title">
          <h2 id="calendar-title" className="text-2xl">
            Calendar
          </h2>
          <p className="mt-1 mb-5 text-sm text-ink-muted">
            Bookings made elsewhere can take a while to appear here. Your dates
            are only secured once you place a hold.
          </p>
          <AvailabilityCalendar
            statuses={await calendarStatuses(
              ctx,
              startOfMonth(
                result.status === "valid" ? result.search.checkIn : today,
              ),
              62,
              now,
            )}
            months={monthsFrom(
              result.status === "valid" ? result.search.checkIn : today,
            )}
            highlight={
              result.status === "valid"
                ? { start: result.search.checkIn, end: result.search.checkOut }
                : undefined
            }
          />
        </section>
      )}
    </div>
  );
}

async function StayResult({
  ctx,
  search,
  today,
  now,
}: {
  ctx: BookingContext;
  search: { checkIn: IsoDate; checkOut: IsoDate; guests: number };
  today: IsoDate;
  now: Date;
}) {
  const [{ available, quote }, syncDelayed] = await Promise.all([
    checkStay(ctx, search, today, now),
    calendarSyncDelayed(ctx, now),
  ]);
  const request = ctx.property.bookingMode === "REQUEST";
  if (!available) {
    return (
      <div className="mt-5 max-w-2xl space-y-2">
        <p className="font-semibold text-pine-900">
          Sorry, the lodge isn&rsquo;t available for all of those nights.
        </p>
        <p>Check the calendar below for open dates, or try a different stay.</p>
      </div>
    );
  }
  if (!quote) {
    return (
      <p className="mt-5 font-semibold text-pine-900">
        Prices for these dates aren&rsquo;t set yet. Please contact the owner.
      </p>
    );
  }
  if (!quote.ok) {
    return (
      <p className="mt-5 font-semibold text-pine-900">
        {describeQuoteError(quote.error)}
      </p>
    );
  }
  const query = new URLSearchParams({
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    guests: String(search.guests),
  });
  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[1.3fr_1fr] lg:items-start">
      <div>
        <p className="font-semibold text-success">Available for your dates</p>
        <div className="mt-4">
          <QuoteSummary
            quote={quote.quote}
            today={today}
            dueLabels={
              request ? { 1: "due once the owner approves" } : undefined
            }
          />
        </div>
      </div>
      <div className="rounded-soft bg-ivory p-5">
        <p className="text-sm text-ink-muted">
          {request
            ? "Nothing is reserved or charged yet. Next, you send a booking request; the owner approves it before you pay."
            : "Nothing is reserved yet. The next step holds these dates for you for 30 minutes while you complete your booking."}
        </p>
        {syncDelayed && (
          <p className="mt-3 text-sm text-notice-ink">
            Our link with other booking calendars is running behind, so the
            owner will double-check these dates before approving.
          </p>
        )}
        <Link
          href={`/book?${query}`}
          className="mt-4 flex min-h-12 items-center justify-center rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700"
        >
          Continue to book
        </Link>
      </div>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div
      className="h-40 animate-pulse rounded-soft bg-mist motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}
