import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { QuoteSummary } from "@/components/quote-summary";
import { Container, PageHeader } from "@/components/ui";
import { searchLimits } from "@/content/property";
import { formatStayDate, todayInTimeZone } from "@/lib/dates";
import { privateRouteMetadata } from "@/lib/metadata";
import { validateStaySearch } from "@/lib/stay-search";
import { POLICY_BEFORE_PAYMENT } from "@/server/booking/cancellation-policy";
import { checkStay, getBookingContext } from "@/server/booking/public";
import { describeQuoteError } from "@/server/pricing/quote";
import { GuestForm } from "./guest-form";

export const metadata = { title: "Your details", ...privateRouteMetadata };

export default function BookPage({ searchParams }: PageProps<"/book">) {
  return (
    <>
      <PageHeader eyebrow="Book direct" title="Your details" />
      <Container className="py-12 sm:py-14">
        <Suspense
          fallback={
            <div className="h-64 rounded-soft bg-mist" aria-hidden="true" />
          }
        >
          <BookingStep searchParams={searchParams} />
        </Suspense>
      </Container>
    </>
  );
}

async function BookingStep({
  searchParams,
}: {
  searchParams: PageProps<"/book">["searchParams"];
}) {
  const params = await searchParams;
  await connection();
  const ctx = await getBookingContext();
  if (!ctx) notFound();

  const now = new Date();
  const today = todayInTimeZone(ctx.property.timeZone, now);
  const result = validateStaySearch(
    params,
    {
      ...searchLimits,
      maxGuests: ctx.property.maxGuests,
      minNights: ctx.property.defaultMinNights,
      horizonDays: ctx.property.bookingHorizonDays,
    },
    today,
  );
  if (result.status !== "valid") redirect("/availability");
  const { search } = result;

  const { available, quote } = await checkStay(ctx, search, today, now);
  if (!available || !quote?.ok) {
    return (
      <div role="alert" className="max-w-2xl space-y-3">
        <p className="font-semibold text-pine-900">
          {!available
            ? "Sorry, those dates are no longer available."
            : quote && !quote.ok
              ? describeQuoteError(quote.error)
              : "Prices for these dates aren’t set yet."}
        </p>
        <Link
          href="/availability"
          className="font-semibold text-pine-800 underline underline-offset-4"
        >
          Search again
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:items-start">
      <section aria-labelledby="guest-title">
        <h2 id="guest-title" className="text-2xl">
          Who&rsquo;s staying
        </h2>
        <p className="mt-2 text-ink-muted">
          We only ask for what we need to look after your stay.
        </p>
        {/* Required by the owner's cancellation decision (no deadline exists
            before payment, so none is shown). Same style as the line above. */}
        <p className="mt-2 mb-6 text-ink-muted">{POLICY_BEFORE_PAYMENT}</p>
        <GuestForm
          stay={{
            checkIn: search.checkIn,
            checkOut: search.checkOut,
            guests: search.guests,
            idempotencyKey: randomUUID(),
          }}
        />
      </section>
      <aside
        aria-labelledby="summary-title"
        className="rounded-soft border border-sage-300 bg-limestone/60 p-6"
      >
        <h2 id="summary-title" className="text-2xl">
          Your stay
        </h2>
        <p className="mt-1 mb-5 text-ink-muted">
          {formatStayDate(search.checkIn)} – {formatStayDate(search.checkOut)} ·{" "}
          {search.nights} nights · {search.guests}{" "}
          {search.guests === 1 ? "guest" : "guests"}
        </p>
        <QuoteSummary quote={quote.quote} today={today} />
      </aside>
    </div>
  );
}
