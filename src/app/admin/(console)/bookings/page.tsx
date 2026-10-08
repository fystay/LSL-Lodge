import Link from "next/link";
import { Suspense } from "react";
import {
  NotReady,
  inputClass,
  smallButton,
  statusLabel,
} from "@/components/admin-ui";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { adminContext } from "@/server/admin/context";
import { PAGE_SIZE, searchReservations } from "@/server/admin/data";

export const metadata = { title: "Bookings" };

export default function BookingsPage({
  searchParams,
}: PageProps<"/admin/bookings">) {
  return (
    <>
      <h1 className="text-title">Bookings</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Bookings searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Bookings({
  searchParams,
}: {
  searchParams: PageProps<"/admin/bookings">["searchParams"];
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const page = Math.max(0, Number(params.page) || 0);
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const rows = await searchReservations(ctx.db, ctx.property.id, q, page);
  const hasMore = rows.length > PAGE_SIZE;

  return (
    <div className="mt-6 space-y-6">
      <form role="search" className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <label htmlFor="q" className="text-sm font-semibold text-pine-900">
            Search by reference, name or email
          </label>
          <input id="q" name="q" defaultValue={q} className={inputClass} />
        </div>
        <button type="submit" className={smallButton}>
          Search
        </button>
      </form>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Bookings table (scrolls sideways on small screens)"
      >
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Bookings</caption>
          <thead>
            <tr className="border-b border-sage-300">
              <th scope="col" className="py-2">
                Reference
              </th>
              <th scope="col">Dates</th>
              <th scope="col">Guest</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-300/70">
            {rows.slice(0, PAGE_SIZE).map((r) => (
              <tr key={r.id}>
                <td className="py-2.5">
                  <Link
                    href={`/admin/bookings/${r.id}`}
                    className="font-semibold text-pine-800 underline underline-offset-4"
                  >
                    {r.publicRef}
                  </Link>
                </td>
                <td>
                  {formatStayDate(r.checkIn as IsoDate)} –{" "}
                  {formatStayDate(r.checkOut as IsoDate)}
                </td>
                <td>{r.guestName}</td>
                <td>{statusLabel(r.status)}</td>
                <td className="text-right tabular-nums">
                  {formatMoney(r.totalMinor, r.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-4">No bookings found.</p>}
      </div>
      <nav aria-label="Pages" className="flex gap-3">
        {page > 0 && (
          <Link
            className={smallButton}
            href={`/admin/bookings?${new URLSearchParams({ q, page: String(page - 1) })}`}
          >
            Previous
          </Link>
        )}
        {hasMore && (
          <Link
            className={smallButton}
            href={`/admin/bookings?${new URLSearchParams({ q, page: String(page + 1) })}`}
          >
            Next
          </Link>
        )}
      </nav>
    </div>
  );
}
