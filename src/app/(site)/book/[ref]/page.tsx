import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { eq } from "drizzle-orm";
import { QuoteSummary } from "@/components/quote-summary";
import { Container, PageHeader } from "@/components/ui";
import { formatStayDate, todayInTimeZone, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { privateRouteMetadata } from "@/lib/metadata";
import { payments } from "@/server/db/schema";
import { findReservationForGuest } from "@/server/booking/holds";
import {
  GUEST_STATUS_LABEL,
  guestStatus,
  type GuestStatus,
} from "@/server/booking/guest-status";
import { getBookingContext } from "@/server/booking/public";
import { applyCheckoutSession } from "@/server/payments/checkout";
import { getPaymentGateway } from "@/server/payments/gateway";
import type { Quote } from "@/server/pricing/quote";
import { guestCancelAction, startPaymentAction } from "../actions";
import { bookingCookieName } from "../cookie";
import { StatusRefresher } from "./refresher";

export const metadata = { title: "Your booking", ...privateRouteMetadata };

export default function BookingStatusPage({
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
          <BookingStatus params={params} searchParams={searchParams} />
        </Suspense>
      </Container>
    </>
  );
}

const CANCEL_NOTICES: Record<string, string> = {
  withdrawn: "Your request has been withdrawn. Nothing was charged.",
  requested:
    "We’ve told the owner you’d like to cancel. Your booking stands until they reply.",
  unconfirmed: "Tick the box to confirm.",
  error: "That couldn’t be done right now. Please contact the owner.",
};

const PAYMENT_NOTICES: Record<string, string> = {
  cancelled:
    "Payment was cancelled and nothing was charged. You can try again below.",
  error:
    "We couldn’t open the secure payment page. Nothing was charged. Please try again in a moment.",
  conflict:
    "These dates now clash with another calendar, so payment can’t go ahead. Nothing was charged. Please contact the owner.",
  unavailable: "Online payment isn’t available for this booking right now.",
};

async function BookingStatus({
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

  const paymentStatus =
    typeof query.payment === "string" ? query.payment : undefined;
  const cancelStatus =
    typeof query.cancel === "string" ? query.cancel : undefined;
  const sessionId =
    typeof query.session_id === "string" ? query.session_id : undefined;
  let paymentRows = await ctx.db
    .select({
      status: payments.status,
      stripeCheckoutSessionId: payments.stripeCheckoutSessionId,
    })
    .from(payments)
    .where(eq(payments.reservationId, reservation.id));

  // Back from Stripe: ask Stripe directly (server to server) rather than
  // trusting the redirect. Only a session already recorded for this booking
  // is looked up. The webhook does the same independently.
  const gateway = getPaymentGateway();
  if (
    paymentStatus === "returned" &&
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
      paymentRows = await ctx.db
        .select({
          status: payments.status,
          stripeCheckoutSessionId: payments.stripeCheckoutSessionId,
        })
        .from(payments)
        .where(eq(payments.reservationId, reservation.id));
    } catch {
      // Stripe unreachable: the webhook will settle it; keep showing "confirming".
    }
  }

  const now = new Date();
  const quote = reservation.quoteSnapshot as Quote;
  const timeZone = ctx.property.timeZone;
  const status = guestStatus(
    {
      status: reservation.status,
      holdExpiresAt: reservation.holdExpiresAt,
      paymentStatuses: paymentRows.map((p) => p.status),
    },
    now,
  );
  const paid = paymentRows.some((p) => p.status === "SUCCEEDED");
  const deadline = reservation.holdExpiresAt
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone,
      }).format(reservation.holdExpiresAt)
    : null;
  const confirming =
    paymentStatus === "returned" &&
    (status === "APPROVED_AWAITING_PAYMENT" ||
      status === "HOLD_AWAITING_PAYMENT" ||
      status === "PAYMENT_PROCESSING");
  const canPay =
    (status === "APPROVED_AWAITING_PAYMENT" ||
      status === "HOLD_AWAITING_PAYMENT") &&
    !confirming;
  const amountDue = formatMoney(
    quote.schedule[0]?.amountMinor ?? 0,
    quote.currency,
  );

  return (
    <div className="grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:items-start">
      <section aria-labelledby="status-title" className="space-y-5">
        <h2 id="status-title" className="text-2xl">
          Booking reference {reservation.publicRef}
        </h2>

        {cancelStatus && CANCEL_NOTICES[cancelStatus] && (
          <p
            role="alert"
            className="rounded-soft border border-sage-300 bg-sage-100 p-4"
          >
            {CANCEL_NOTICES[cancelStatus]}
          </p>
        )}

        {paymentStatus && PAYMENT_NOTICES[paymentStatus] && (
          <p
            role="alert"
            className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
          >
            {PAYMENT_NOTICES[paymentStatus]}
          </p>
        )}

        <div
          role="status"
          className="rounded-soft border border-sage-300 bg-ivory p-5"
        >
          <p className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
            Status
          </p>
          <p className="mt-1 text-xl font-semibold text-pine-900">
            {confirming
              ? "Confirming your payment…"
              : GUEST_STATUS_LABEL[status]}
          </p>
          <div className="mt-3 space-y-3">
            {confirming ? (
              <>
                <p>
                  Thank you. We&rsquo;re checking your payment with our payment
                  provider. This page updates by itself; your booking is
                  confirmed only once the payment has been verified.
                </p>
                <StatusRefresher />
              </>
            ) : (
              <StatusCopy
                status={status}
                deadline={deadline}
                amountDue={amountDue}
                paid={paid}
                wasApproved={reservation.approvedAt !== null}
              />
            )}
            {status === "PAYMENT_PROCESSING" && !confirming && (
              <StatusRefresher everyMs={10_000} maxTimes={30} />
            )}
          </div>
        </div>

        {canPay &&
          (gateway ? (
            <form action={startPaymentAction} className="space-y-2">
              <input type="hidden" name="ref" value={reservation.publicRef} />
              <button
                type="submit"
                className="min-h-12 w-full rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700 sm:w-auto"
              >
                Pay {amountDue} securely
              </button>
              <p className="text-sm text-ink-muted">
                You&rsquo;ll pay on Stripe&rsquo;s secure page. We never see
                your card details.
              </p>
            </form>
          ) : (
            <p className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink">
              Online payment isn&rsquo;t switched on in this preview, so nothing
              can be charged.
            </p>
          ))}

        {(status === "AWAITING_APPROVAL" ||
          status === "APPROVED_AWAITING_PAYMENT" ||
          ((status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE") &&
            !reservation.cancellationRequestedAt)) && (
          <details className="rounded-soft border border-sage-300 p-4">
            <summary className="cursor-pointer font-semibold">
              {status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE"
                ? "Need to cancel?"
                : "Withdraw this request"}
            </summary>
            <form action={guestCancelAction} className="mt-3 space-y-3">
              <input type="hidden" name="ref" value={reservation.publicRef} />
              <p className="text-sm">
                {status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE"
                  ? "This sends a cancellation request to the owner. Your booking stays in place until they reply, under the cancellation policy."
                  : "Nothing has been charged. Withdrawing releases the dates straight away."}
              </p>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  name="confirm"
                  value="yes"
                  className="size-5"
                />
                <span>
                  {status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE"
                    ? "Yes, ask the owner to cancel"
                    : "Yes, withdraw my request"}
                </span>
              </label>
              <button
                type="submit"
                className="min-h-11 rounded-soft border border-pine-800 px-4 text-sm font-semibold text-pine-900 hover:bg-sage-100"
              >
                {status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE"
                  ? "Send cancellation request"
                  : "Withdraw request"}
              </button>
            </form>
          </details>
        )}

        <p className="text-sm text-ink-muted">
          Keep this page&rsquo;s address and our emails private: they give
          access to your booking on this device.{" "}
          <Link href="/contact" className="underline underline-offset-4">
            Contact the owner
          </Link>{" "}
          with any questions.
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
          dueLabels={dueLabels(status, deadline)}
        />
      </aside>
    </div>
  );
}

function dueLabels(
  status: GuestStatus,
  deadline: string | null,
): Partial<Record<number, string>> | undefined {
  if (status === "AWAITING_APPROVAL")
    return { 1: "due once the owner approves" };
  if (status === "APPROVED_AWAITING_PAYMENT" && deadline)
    return { 1: `due by ${deadline}` };
  if (status === "CONFIRMED" || status === "CONFIRMED_BALANCE_DUE")
    return { 1: "paid" };
  if (status === "DECLINED" || status === "EXPIRED" || status === "CANCELLED")
    return { 1: "not due" };
  return undefined;
}

function StatusCopy({
  status,
  deadline,
  amountDue,
  paid,
  wasApproved,
}: {
  status: GuestStatus;
  deadline: string | null;
  amountDue: string;
  paid: boolean;
  wasApproved: boolean;
}): ReactNode {
  switch (status) {
    case "AWAITING_APPROVAL":
      return (
        <>
          <p>
            Your request has been sent to the owner.{" "}
            <strong>Nothing has been charged</strong> and this is not yet a
            confirmed booking.
          </p>
          <p>
            The owner will reply by <strong>{deadline}</strong> (UK time), and
            your dates are held for you until then. We&rsquo;ll email you either
            way.
          </p>
        </>
      );
    case "APPROVED_AWAITING_PAYMENT":
      return (
        <p>
          The owner has approved your request. To confirm the booking, pay the
          full amount of <strong>{amountDue}</strong> by{" "}
          <strong>{deadline}</strong> (UK time). Until payment has gone through,
          the booking is not confirmed; after that time the dates are released.
        </p>
      );
    case "HOLD_AWAITING_PAYMENT":
      return (
        <p>
          We&rsquo;re holding these dates until <strong>{deadline}</strong> (UK
          time). They&rsquo;re confirmed only once payment has been verified.
        </p>
      );
    case "PAYMENT_PROCESSING":
      return (
        <p>
          Your payment is being processed. Your booking will be confirmed as
          soon as the payment provider tells us it has gone through; this page
          updates by itself.
        </p>
      );
    case "CONFIRMED":
      return (
        <p>
          Your booking is confirmed and your payment has been received. You can
          come back to this page at any time to see your booking.
        </p>
      );
    case "CONFIRMED_BALANCE_DUE":
      return (
        <p>
          Your booking is confirmed. The remaining balance is shown in the
          payment schedule.
        </p>
      );
    case "DECLINED":
      return (
        <p>
          Sorry, the owner wasn&rsquo;t able to accept this request.{" "}
          <strong>Nothing was charged</strong> and the dates have been released.{" "}
          <Link href="/availability" className="underline underline-offset-4">
            Look for other dates
          </Link>
          .
        </p>
      );
    case "EXPIRED":
      return paid ? (
        <p>
          We received a payment after this booking had lapsed. The owner has
          been alerted and will contact you.
        </p>
      ) : (
        <p>
          {wasApproved
            ? "Payment wasn’t completed in time, so the dates have been released."
            : "The owner wasn’t able to reply in time, so the request has lapsed."}{" "}
          <strong>Nothing was charged.</strong>{" "}
          <Link href="/availability" className="underline underline-offset-4">
            Search again
          </Link>
          .
        </p>
      );
    case "CANCELLED":
      return <p>This booking has been cancelled.</p>;
    case "UNDER_REVIEW":
      return (
        <p>
          The owner is reviewing this booking and will contact you. It
          isn&rsquo;t confirmed yet.
        </p>
      );
  }
}
