import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { QuoteSummary } from "@/components/quote-summary";
import { Container, PageHeader } from "@/components/ui";
import { formatStayDate, todayInTimeZone, type IsoDate } from "@/lib/dates";
import { privateRouteMetadata } from "@/lib/metadata";
import { paymentScheduleItems, payments } from "@/server/db/schema";
import { findReservationForGuest } from "@/server/booking/holds";
import {
  formatDeadline,
  refundEligible,
} from "@/server/booking/cancellation-policy";
import { applyCheckoutSession } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import { getBookingContext } from "@/server/booking/public";
import type { Quote } from "@/server/pricing/quote";
import { bookingCookieName } from "../cookie";

export const metadata = { title: "Your booking", ...privateRouteMetadata };

export default function HoldPage({
  params,
  searchParams,
}: PageProps<"/book/[ref]">) {
  return (
    <>
      <PageHeader eyebrow="Book direct" title="Your booking" />
      <Container className="py-12 sm:py-14">
        <Suspense
          fallback={
            <div className="h-64 rounded-soft bg-mist" aria-hidden="true" />
          }
        >
          <HoldDetails params={params} searchParams={searchParams} />
        </Suspense>
      </Container>
    </>
  );
}

async function HoldDetails({
  params,
  searchParams,
}: {
  params: PageProps<"/book/[ref]">["params"];
  searchParams: PageProps<"/book/[ref]">["searchParams"];
}) {
  const { ref } = await params;
  const query = await searchParams;
  await connection();
  const token = (await cookies()).get(bookingCookieName(ref))?.value;
  const ctx = await getBookingContext();
  // Same response whether the reference is unknown or the token is wrong.
  if (!ctx || !token || !/^LL-[A-Z0-9]{6}$/.test(ref)) notFound();
  let reservation = await findReservationForGuest(ctx.db, ref, token);
  if (!reservation) notFound();

  // Back from Stripe: ask Stripe directly (server to server) rather than
  // trusting the redirect, for a session already recorded on this booking.
  // The signed webhook settles it independently; either may confirm first.
  const gateway = getPaymentGateway();
  const sessionId =
    typeof query.session_id === "string" ? query.session_id : undefined;
  const loadPayments = (id: string) =>
    ctx.db
      .select({
        kind: payments.kind,
        status: payments.status,
        stripeCheckoutSessionId: payments.stripeCheckoutSessionId,
      })
      .from(payments)
      .where(eq(payments.reservationId, id));
  let paymentRows = await loadPayments(reservation.id);
  if (
    sessionId &&
    gateway &&
    paymentRows.some(
      (p) =>
        p.stripeCheckoutSessionId === sessionId &&
        (p.status === "PENDING" || p.status === "PROCESSING"),
    )
  ) {
    try {
      await applyCheckoutSession(
        ctx.db,
        await gateway.retrieveCheckoutSession(sessionId),
      );
      reservation = (await findReservationForGuest(ctx.db, ref, token))!;
      paymentRows = await loadPayments(reservation.id);
    } catch {
      // Stripe unreachable: the webhook will settle it.
    }
  }
  const paid = paymentRows.some(
    (p) => p.kind === "CHARGE" && p.status === "SUCCEEDED",
  );
  // Schedule items the server has marked paid (only after verified payment).
  const paidSequences = (
    await ctx.db
      .select({
        sequence: paymentScheduleItems.sequence,
        status: paymentScheduleItems.status,
      })
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, reservation.id))
  )
    .filter((item) => item.status === "PAID")
    .map((item) => item.sequence);

  const now = new Date();
  const quote = reservation.quoteSnapshot as Quote;
  const timeZone = ctx.property.timeZone;
  const lapsed =
    !paid &&
    (reservation.status === "EXPIRED" ||
      (reservation.status === "PENDING_PAYMENT" &&
        reservation.holdExpiresAt !== null &&
        reservation.holdExpiresAt <= now));
  const confirmed =
    reservation.status === "CONFIRMED" || reservation.status === "PAYMENT_DUE";
  const deadline = reservation.freeCancellationUntil;
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
            {!gateway && (
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
            )}
          </div>
        ) : confirmed ? (
          // Approved by the owner (October 2026): confirmed status, the
          // cancellation deadline and "contact the owner to cancel", in the
          // page's existing styles. No cancellation form.
          <div role="status" className="space-y-3">
            <p>Status: confirmed. Your payment has been received.</p>
            {deadline &&
              (refundEligible(deadline, now) ? (
                <p>
                  You can cancel for a full refund until{" "}
                  <strong>{formatDeadline(deadline, timeZone)}</strong> (UK
                  time), 24 hours after your booking was confirmed. After that,
                  the booking is non-refundable.
                </p>
              ) : (
                <p>
                  The free-cancellation period ended at{" "}
                  <strong>{formatDeadline(deadline, timeZone)}</strong> (UK
                  time). The booking is now non-refundable.
                </p>
              ))}
            <p>
              To cancel,{" "}
              <Link href="/contact" className="underline">
                contact the owner
              </Link>
              . Your cancellation counts from when your message reaches us.
            </p>
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
        <QuoteSummary
          quote={quote}
          today={todayInTimeZone(timeZone, now)}
          paidSequences={paidSequences}
        />
      </aside>
    </div>
  );
}
