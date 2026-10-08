import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSearch } from "@/components/booking-search";
import { Container, PageHeader } from "@/components/ui";
import { searchLimits } from "@/content/property";
import { formatStayDate, todayInTimeZone } from "@/lib/dates";
import { pageMetadata } from "@/lib/metadata";
import { bookingOpen } from "@/lib/site";
import { validateStaySearch } from "@/lib/stay-search";

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
  const today = todayInTimeZone(TIME_ZONE);
  const result = validateStaySearch(params, searchLimits, today);

  const form = (
    <BookingSearch
      key={JSON.stringify(params)}
      variant="inline"
      maxGuests={searchLimits.maxGuests}
      minNights={searchLimits.minNights}
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
          {bookingOpen ? null : (
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
