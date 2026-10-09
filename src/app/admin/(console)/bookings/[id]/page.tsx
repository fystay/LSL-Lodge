import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  AdminSection,
  FormStatus,
  NotReady,
  inputClass,
  primaryButton,
  smallButton,
  statusLabel,
} from "@/components/admin-ui";
import { QuoteSummary } from "@/components/quote-summary";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { adminContext } from "@/server/admin/context";
import { reservationConflicts, reservationDetail } from "@/server/admin/data";
import { paymentsConfigured } from "@/server/payments/gateway";
import { refundableCharges } from "@/server/payments/refunds";
import { penceToPounds } from "@/server/admin/schemas";
import type { Quote } from "@/server/pricing/quote";
import {
  approveRequestAction,
  cancelBookingAction,
  confirmReviewedAction,
  declineRequestAction,
  refundAction,
  resolveFlagAction,
} from "../../../actions";

const CANCELLABLE = [
  "APPROVED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "REQUIRES_REVIEW",
];

export const metadata = { title: "Booking" };

const SOURCE_LABEL: Record<string, string> = {
  OWNER_BLOCK: "Your blocked dates",
  AIRBNB_ICAL: "Airbnb (imported calendar)",
  GOOGLE: "Google Calendar",
  OTHER_ICAL: "Imported calendar",
  CHANNEL_MANAGER: "Channel manager",
  DIRECT_BOOKING: "Another website booking",
  HOLD: "Another request or hold",
};

const REVIEW_REASON: Record<string, string> = {
  PAYMENT_AFTER_EXPIRY:
    "Payment arrived after the booking lapsed. Decide whether to honour the booking or refund.",
  PAYMENT_AFTER_EXPIRY_REFUND_REQUIRED:
    "Payment arrived after the booking lapsed and the dates had been re-booked. The payment must be refunded.",
  AMOUNT_MISMATCH:
    "The amount paid doesn’t match the agreed price. Check the payment in Stripe.",
  CALENDAR_CONFLICT:
    "Payment was received, but another calendar now overlaps these dates. Resolve the clash before confirming.",
  DUPLICATE_PAYMENT:
    "A second payment was received for an already confirmed booking. Refund the duplicate.",
  DUPLICATE_PAYMENT_REFUND_REQUIRED:
    "A second payment was received for this confirmed booking. The booking stands; refund the extra payment below.",
  CANCELLED_REFUND_DECISION:
    "This booking was cancelled after payment. Decide on any refund under your policy, then refund below or mark it handled.",
  NOT_APPROVED: "Payment was received for a request that was never approved.",
};

const when = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/London",
      }).format(d)
    : "—";

export default function BookingDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/bookings/[id]">) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Detail params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Detail({
  params,
  searchParams,
}: {
  params: PageProps<"/admin/bookings/[id]">["params"];
  searchParams: PageProps<"/admin/bookings/[id]">["searchParams"];
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready) return <NotReady reason={ctx.reason} />;
  const detail = await reservationDetail(ctx.db, ctx.property.id, id);
  if (!detail) notFound();
  const { reservation: r, schedule, payments, history, notifications } = detail;
  const quote = r.quoteSnapshot as Quote;
  const pending = r.status === "REQUESTED";
  const conflicts =
    pending || r.status === "APPROVED" || r.status === "REQUIRES_REVIEW"
      ? await reservationConflicts(
          ctx.db,
          r,
          ctx.property.turnoverNights,
          ctx.now,
        )
      : [];
  const reason = r.reviewReason
    ? (REVIEW_REASON[r.reviewReason] ?? r.reviewReason)
    : null;
  const charges = await refundableCharges(ctx.db, r.id);
  const refundable = charges.filter((c) => c.refundableMinor > 0);
  const canCancel = CANCELLABLE.includes(r.status);
  const showActions =
    canCancel ||
    refundable.length > 0 ||
    (r.reviewReason && r.status !== "REQUIRES_REVIEW");

  return (
    <>
      <h1 className="text-title">Booking {r.publicRef}</h1>
      <div className="mt-4">
        <FormStatus
          saved={typeof saved === "string" ? saved : undefined}
          error={typeof error === "string" ? error : undefined}
        />
      </div>

      {reason && (
        <p
          role="alert"
          className="mt-4 rounded-soft border border-danger/40 bg-ivory p-4 font-medium text-danger"
        >
          Needs your attention: {reason}
        </p>
      )}

      {r.cancellationRequestedAt &&
        !["CANCELLED", "REFUND_PENDING", "REFUNDED"].includes(r.status) && (
          <p
            role="status"
            className="mt-4 rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
          >
            The guest asked to cancel on {when(r.cancellationRequestedAt)}. The
            booking stands until you act.
          </p>
        )}

      {showActions && (
        <div className="mt-6">
          <AdminSection id="actions" title="Resolve, cancel or refund">
            <p className="text-sm text-ink-muted">
              These actions ask for a fresh authenticator code. Refund amounts
              are your decision: nothing is calculated from a policy.
            </p>
            <div className="mt-4 grid gap-6 md:grid-cols-2">
              {r.status === "REQUIRES_REVIEW" && (
                <form action={confirmReviewedAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <h3 className="font-sans text-base font-semibold">
                    Confirm the booking
                  </h3>
                  <p className="text-sm">
                    Only possible when verified payments cover the agreed{" "}
                    {formatMoney(r.totalMinor, r.currency)} and nothing else
                    overlaps the dates.
                  </p>
                  <button type="submit" className={primaryButton}>
                    Confirm booking
                  </button>
                </form>
              )}
              {canCancel && (
                <form action={cancelBookingAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <h3 className="font-sans text-base font-semibold">
                    Cancel the booking
                  </h3>
                  <label
                    htmlFor="cancel-note"
                    className="block text-sm font-semibold"
                  >
                    Private note (optional)
                  </label>
                  <textarea
                    id="cancel-note"
                    name="ownerNote"
                    rows={2}
                    maxLength={1000}
                    className={inputClass}
                  />
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      name="confirm"
                      value="yes"
                      className="size-5"
                    />
                    <span>Yes, cancel and release the dates</span>
                  </label>
                  <button type="submit" className={smallButton}>
                    Cancel booking
                  </button>
                </form>
              )}
              {refundable.map(({ charge, refundableMinor }) => (
                <form
                  key={charge.id}
                  action={refundAction}
                  className="space-y-3"
                >
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="chargeId" value={charge.id} />
                  <h3 className="font-sans text-base font-semibold">
                    Refund payment of{" "}
                    {formatMoney(charge.amountMinor, charge.currency)}
                  </h3>
                  <p className="text-sm">
                    Up to {formatMoney(refundableMinor, charge.currency)} can
                    still be refunded
                    {charge.failureCode?.endsWith("REFUND_REQUIRED")
                      ? " (flagged for refund)"
                      : ""}
                    .
                  </p>
                  <label
                    htmlFor={`amount-${charge.id}`}
                    className="block text-sm font-semibold"
                  >
                    Amount to refund (£)
                  </label>
                  <input
                    id={`amount-${charge.id}`}
                    name="amount"
                    inputMode="decimal"
                    required
                    defaultValue={penceToPounds(refundableMinor)}
                    className={inputClass}
                  />
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      name="confirm"
                      value="yes"
                      className="size-5"
                    />
                    <span>Yes, send this refund to the guest&rsquo;s card</span>
                  </label>
                  <button
                    type="submit"
                    className={smallButton}
                    disabled={!paymentsConfigured()}
                  >
                    Refund
                  </button>
                </form>
              ))}
              {r.reviewReason && r.status !== "REQUIRES_REVIEW" && (
                <form action={resolveFlagAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <h3 className="font-sans text-base font-semibold">
                    Mark as handled
                  </h3>
                  <label
                    htmlFor="resolve-note"
                    className="block text-sm font-semibold"
                  >
                    How was it handled? (kept in the history)
                  </label>
                  <textarea
                    id="resolve-note"
                    name="note"
                    rows={2}
                    required
                    minLength={3}
                    maxLength={500}
                    className={inputClass}
                  />
                  <button type="submit" className={smallButton}>
                    Mark as handled
                  </button>
                </form>
              )}
            </div>
          </AdminSection>
        </div>
      )}

      {pending && (
        <div className="mt-6">
          <AdminSection id="decision" title="Your decision">
            <p>
              Respond by <strong>{when(r.holdExpiresAt)}</strong> (UK time).
              After that the request lapses and the dates are released. The
              guest has not been charged.
            </p>
            {conflicts.length > 0 ? (
              <div
                role="alert"
                className="mt-3 rounded-soft border border-danger/40 bg-ivory p-3 text-danger"
              >
                <p className="font-semibold">
                  These dates now overlap other calendar entries:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {conflicts.map((c) => (
                    <li key={c}>{SOURCE_LABEL[c] ?? c}</li>
                  ))}
                </ul>
                <p className="mt-1">
                  Approval is blocked until the clash is resolved.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-muted">
                No clashes with your blocked dates or imported calendars as of
                their last sync. Imported calendars (such as Airbnb) can lag
                behind, so check them if in doubt.
              </p>
            )}
            {!paymentsConfigured() && (
              <p className="mt-3 rounded-soft border border-notice-ink/30 bg-notice p-3 text-notice-ink">
                Card payments aren&rsquo;t configured on this site, so an
                approved guest won&rsquo;t be able to pay yet.
              </p>
            )}
            <div className="mt-5 grid gap-6 md:grid-cols-2">
              <form action={approveRequestAction} className="space-y-3">
                <input type="hidden" name="id" value={r.id} />
                <label htmlFor="approve-note" className="block font-semibold">
                  Private note (optional)
                </label>
                <textarea
                  id="approve-note"
                  name="ownerNote"
                  maxLength={1000}
                  rows={2}
                  className={inputClass}
                />
                <p className="text-sm text-ink-muted">
                  The guest will be asked to pay{" "}
                  {formatMoney(r.totalMinor, r.currency)} within{" "}
                  {ctx.property.paymentWindowHours} hours.
                </p>
                <button
                  type="submit"
                  className={primaryButton}
                  disabled={conflicts.length > 0}
                >
                  Approve request
                </button>
              </form>
              <form action={declineRequestAction} className="space-y-3">
                <input type="hidden" name="id" value={r.id} />
                <label htmlFor="decline-note" className="block font-semibold">
                  Private note (optional, not sent to the guest)
                </label>
                <textarea
                  id="decline-note"
                  name="ownerNote"
                  maxLength={1000}
                  rows={2}
                  className={inputClass}
                />
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    name="confirm"
                    value="yes"
                    className="size-5"
                  />
                  <span>Yes, decline this request</span>
                </label>
                <button type="submit" className={smallButton}>
                  Decline request
                </button>
              </form>
            </div>
          </AdminSection>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <AdminSection id="stay" title="Stay">
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2">
            <dt className="font-semibold">Status</dt>
            <dd>{statusLabel(r.status)}</dd>
            <dt className="font-semibold">Dates</dt>
            <dd>
              {formatStayDate(r.checkIn as IsoDate)} –{" "}
              {formatStayDate(r.checkOut as IsoDate)}
            </dd>
            <dt className="font-semibold">Guests</dt>
            <dd>{r.guests}</dd>
            <dt className="font-semibold">Lead guest</dt>
            <dd>{r.guestName}</dd>
            <dt className="font-semibold">Email</dt>
            <dd className="break-all">{r.guestEmail}</dd>
            <dt className="font-semibold">Phone</dt>
            <dd>{r.guestPhone ?? "—"}</dd>
            <dt className="font-semibold">Source</dt>
            <dd>{r.source === "DIRECT" ? "Website" : "Entered by owner"}</dd>
            <dt className="font-semibold">Requested</dt>
            <dd>{when(r.createdAt)}</dd>
            {r.approvedAt && (
              <>
                <dt className="font-semibold">Approved</dt>
                <dd>
                  {when(r.approvedAt)} by {r.approvedBy}
                </dd>
              </>
            )}
            {r.declinedAt && (
              <>
                <dt className="font-semibold">Declined</dt>
                <dd>
                  {when(r.declinedAt)} by {r.declinedBy}
                </dd>
              </>
            )}
            {r.status === "APPROVED" && (
              <>
                <dt className="font-semibold">Pay by</dt>
                <dd>{when(r.holdExpiresAt)}</dd>
              </>
            )}
            {r.confirmedAt && (
              <>
                <dt className="font-semibold">Confirmed</dt>
                <dd>{when(r.confirmedAt)}</dd>
              </>
            )}
            {r.ownerNote && (
              <>
                <dt className="font-semibold">Your note</dt>
                <dd className="whitespace-pre-line">{r.ownerNote}</dd>
              </>
            )}
          </dl>
        </AdminSection>
        <AdminSection id="price" title="Agreed price">
          <QuoteSummary quote={quote} />
        </AdminSection>
        <AdminSection id="payments" title="Payment schedule and payments">
          <ul className="divide-y divide-sage-300/70">
            {schedule.map((s) => (
              <li key={s.id} className="flex justify-between py-2">
                <span>
                  {s.purpose.toLowerCase()} due{" "}
                  {formatStayDate(s.dueOn as IsoDate)} ·{" "}
                  {s.status.toLowerCase()}
                </span>
                <span className="tabular-nums">
                  {formatMoney(s.paidMinor, r.currency)} of{" "}
                  {formatMoney(s.amountMinor, r.currency)} paid
                </span>
              </li>
            ))}
          </ul>
          {payments.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">
              No payment attempts yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {payments.map((p) => (
                <li key={p.id}>
                  {when(p.createdAt)} · {p.kind.toLowerCase()}{" "}
                  {formatMoney(p.amountMinor, p.currency)} ·{" "}
                  <strong>{p.status.toLowerCase()}</strong>
                  {p.failureCode ? ` (${p.failureCode})` : ""}
                  {p.stripePaymentIntentId
                    ? ` · Stripe ${p.stripePaymentIntentId}`
                    : ""}
                </li>
              ))}
            </ul>
          )}
        </AdminSection>
        <AdminSection id="emails" title="Messages">
          {notifications.length === 0 ? (
            <p>No messages.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {notifications.map((n) => (
                <li key={n.id}>
                  {when(n.createdAt)} · {n.template.replaceAll("_", " ")} (to{" "}
                  {n.recipientKind.toLowerCase()}) ·{" "}
                  <strong>
                    {n.status === "SUPPRESSED"
                      ? "not sent (email delivery off)"
                      : n.status.toLowerCase()}
                  </strong>
                  {n.lastErrorCode ? ` · ${n.lastErrorCode}` : ""} ·{" "}
                  <Link
                    href={`/admin/bookings/${r.id}/messages/${n.id}`}
                    className="underline underline-offset-4"
                  >
                    Preview
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AdminSection>
        <AdminSection id="history" title="History">
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id}>
                {when(h.createdAt)} · {h.action} · {h.actorType.toLowerCase()}
                {h.actorId ? ` (${h.actorId})` : ""}
              </li>
            ))}
          </ul>
        </AdminSection>
      </div>
    </>
  );
}
