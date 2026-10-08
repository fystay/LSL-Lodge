import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { QuoteSummary } from "@/components/quote-summary";
import { Container, PageHeader } from "@/components/ui";
import { formatStayDate, todayInTimeZone, type IsoDate } from "@/lib/dates";
import { privateRouteMetadata } from "@/lib/metadata";
import { findReservationForGuest } from "@/server/booking/holds";
import { getBookingContext } from "@/server/booking/public";
import type { Quote } from "@/server/pricing/quote";
import { bookingCookieName } from "../cookie";

export const metadata = { title: "Your booking", ...privateRouteMetadata };

export default function HoldPage({ params }: PageProps<"/book/[ref]">) {
  return (
    <>
      <PageHeader eyebrow="Book direct" title="Your booking" />
      <Container className="py-12 sm:py-14">
        <Suspense
          fallback={
            <div className="h-64 rounded-soft bg-mist" aria-hidden="true" />
          }
        >
          <HoldDetails params={params} />
        </Suspense>
      </Container>
    </>
  );
}

async function HoldDetails({
  params,
}: {
  params: PageProps<"/book/[ref]">["params"];
}) {
  const { ref } = await params;
  await connection();
  const token = (await cookies()).get(bookingCookieName(ref))?.value;
  const ctx = await getBookingContext();
  // Same response whether the reference is unknown or the token is wrong.
  if (!ctx || !token || !/^LL-[A-Z0-9]{6}$/.test(ref)) notFound();
  const reservation = await findReservationForGuest(ctx.db, ref, token);
  if (!reservation) notFound();

  const now = new Date();
  const quote = reservation.quoteSnapshot as Quote;
  const timeZone = ctx.property.timeZone;
  const lapsed =
    reservation.status === "EXPIRED" ||
    (reservation.status === "PENDING_PAYMENT" &&
      reservation.holdExpiresAt !== null &&
      reservation.holdExpiresAt <= now);
  const expiresAt = reservation.holdExpiresAt
    ? new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone }).format(
        reservation.holdExpiresAt,
      )
    : null;

  return (
    <div className="grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:items-start">
      <section aria-labelledby="status-title" className="space-y-4">
        <h2 id="status-title" className="text-2xl">
          Booking reference {reservation.publicRef}
        </h2>
        {lapsed ? (
          <div
            role="status"
            className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
          >
            <p className="font-semibold">This hold has lapsed.</p>
            <p className="mt-1">
              The dates were released and nothing was charged.{" "}
              <Link href="/availability" className="underline">
                Search again
              </Link>
              .
            </p>
          </div>
        ) : reservation.status === "PENDING_PAYMENT" ? (
          <div role="status" className="space-y-3">
            <p>
              We&rsquo;re holding these dates for you until{" "}
              <strong>{expiresAt}</strong> (UK time). They&rsquo;re confirmed
              only once payment has been verified.
            </p>
            <div className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink">
              <p className="font-semibold">
                Payment isn&rsquo;t switched on yet.
              </p>
              <p className="mt-1">
                This is a preview of the booking flow. The secure payment step
                is being built, so nothing can be charged and this hold will
                simply lapse.
              </p>
            </div>
          </div>
        ) : (
          <p role="status">
            Status: {reservation.status.replaceAll("_", " ").toLowerCase()}.
          </p>
        )}
        <p className="text-sm text-ink-muted">
          Keep this page&rsquo;s address private: it shows your booking details
          on this device.
        </p>
      </section>
      <aside
        aria-labelledby="summary-title"
        className="rounded-soft border border-sage-300 bg-limestone/60 p-6"
      >
        <h2 id="summary-title" className="text-2xl">
          Your stay
        </h2>
        <p className="mt-1 mb-5 text-ink-muted">
          {formatStayDate(reservation.checkIn as IsoDate)} –{" "}
          {formatStayDate(reservation.checkOut as IsoDate)} · {quote.nights}{" "}
          nights · {reservation.guests}{" "}
          {reservation.guests === 1 ? "guest" : "guests"}
        </p>
        <QuoteSummary quote={quote} today={todayInTimeZone(timeZone, now)} />
      </aside>
    </div>
  );
}
