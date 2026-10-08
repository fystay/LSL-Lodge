import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AdminSection, NotReady, statusLabel } from "@/components/admin-ui";
import { QuoteSummary } from "@/components/quote-summary";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { adminContext } from "@/server/admin/context";
import { reservationDetail } from "@/server/admin/data";
import type { Quote } from "@/server/pricing/quote";

export const metadata = { title: "Booking" };

export default function BookingDetailPage({
  params,
}: PageProps<"/admin/bookings/[id]">) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Detail params={params} />
    </Suspense>
  );
}

async function Detail({
  params,
}: {
  params: PageProps<"/admin/bookings/[id]">["params"];
}) {
  const { id } = await params;
  const ctx = await adminContext();
  if (!ctx.ready) return <NotReady reason={ctx.reason} />;
  const detail = await reservationDetail(ctx.db, ctx.property.id, id);
  if (!detail) notFound();
  const { reservation: r, schedule, payments, history } = detail;
  const quote = r.quoteSnapshot as Quote;

  return (
    <>
      <h1 className="text-title">Booking {r.publicRef}</h1>
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
            {r.holdExpiresAt && r.status === "PENDING_PAYMENT" && (
              <>
                <dt className="font-semibold">Hold expires</dt>
                <dd>
                  {r.holdExpiresAt.toISOString().slice(0, 16).replace("T", " ")}{" "}
                  UTC
                </dd>
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
          <p className="mt-3 text-sm text-ink-muted">
            {payments.length === 0
              ? "No payments recorded. Card payments arrive with Stripe in Phase 3."
              : `${payments.length} payment record(s).`}
          </p>
        </AdminSection>
        <AdminSection id="history" title="History">
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id}>
                {h.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC ·{" "}
                {h.action} · {h.actorType.toLowerCase()}
              </li>
            ))}
          </ul>
        </AdminSection>
      </div>
    </>
  );
}
