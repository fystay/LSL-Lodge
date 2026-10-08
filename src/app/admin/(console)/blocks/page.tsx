import { Suspense } from "react";
import {
  AdminSection,
  Field,
  FormStatus,
  NotReady,
  inputClass,
  primaryButton,
  smallButton,
} from "@/components/admin-ui";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { adminContext } from "@/server/admin/context";
import { activeOwnerBlocks } from "@/server/admin/data";
import { addOwnerBlockAction, removeOwnerBlockAction } from "../../actions";

export const metadata = { title: "Blocked dates" };

export default function BlocksPage({
  searchParams,
}: PageProps<"/admin/blocks">) {
  return (
    <>
      <h1 className="text-title">Blocked dates</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Blocks searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Blocks({
  searchParams,
}: {
  searchParams: PageProps<"/admin/blocks">["searchParams"];
}) {
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const blocks = await activeOwnerBlocks(ctx.db, ctx.property.id, ctx.today);

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        saved={typeof saved === "string" ? saved : undefined}
        error={typeof error === "string" ? error : undefined}
      />
      <AdminSection id="add" title="Block dates">
        <p className="mb-4 text-sm text-ink-muted">
          Nights from the first date up to (not including) the end date become
          unavailable, e.g. 1–3 June blocks the nights of 1 and 2 June.
        </p>
        <form
          action={addOwnerBlockAction}
          className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
        >
          <Field label="First night" name="startsOn">
            <input
              id="startsOn"
              name="startsOn"
              type="date"
              required
              min={ctx.today}
              className={inputClass}
            />
          </Field>
          <Field label="End date (morning after last night)" name="endsOn">
            <input
              id="endsOn"
              name="endsOn"
              type="date"
              required
              min={ctx.today}
              className={inputClass}
            />
          </Field>
          <Field label="Reason (private)" name="reason">
            <input
              id="reason"
              name="reason"
              maxLength={200}
              className={inputClass}
            />
          </Field>
          <button type="submit" className={primaryButton}>
            Block dates
          </button>
        </form>
      </AdminSection>
      <AdminSection id="current" title="Current and upcoming blocks">
        {blocks.length === 0 ? (
          <p>No blocked dates.</p>
        ) : (
          <ul className="divide-y divide-sage-300/70">
            {blocks.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span>
                  <strong>
                    {formatStayDate(b.startsOn as IsoDate)} –{" "}
                    {formatStayDate(b.endsOn as IsoDate)}
                  </strong>
                  {b.reason ? ` · ${b.reason}` : ""}
                </span>
                <form
                  action={removeOwnerBlockAction}
                  className="flex items-center gap-3"
                >
                  <input type="hidden" name="id" value={b.id} />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="confirm"
                      value="yes"
                      required
                      className="size-5"
                    />
                    Confirm
                  </label>
                  <button type="submit" className={smallButton}>
                    Remove block
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
    </div>
  );
}
