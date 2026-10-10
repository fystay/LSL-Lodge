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
import { formatMoney } from "@/lib/money";
import { adminContext } from "@/server/admin/context";
import { pricingOverview } from "@/server/admin/data";
import { penceToPounds } from "@/server/admin/schemas";
import {
  createFeeRuleAction,
  createRateRuleAction,
  savePaymentPolicyAction,
  toggleFeeRuleAction,
  toggleRateRuleAction,
  updateRateRuleAction,
} from "../../actions";

export const metadata = { title: "Pricing" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FEE_KIND = {
  PER_STAY: "Per stay",
  PER_NIGHT: "Per night",
  PER_GUEST_PER_NIGHT: "Per extra guest per night",
  PERCENT_OF_ACCOMMODATION: "% of accommodation",
} as const;
const TAX = {
  UNCONFIRMED: "Not yet confirmed",
  INCLUDED: "Tax included",
  EXCLUDED: "Tax added separately",
  NOT_APPLICABLE: "No tax applies",
} as const;

export default function PricingPage({
  searchParams,
}: PageProps<"/admin/pricing">) {
  return (
    <>
      <h1 className="text-title">Pricing</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Pricing searchParams={searchParams} />
      </Suspense>
    </>
  );
}

type RateRow = Awaited<ReturnType<typeof pricingOverview>>["rates"][number];

function RateFields({ rate }: { rate?: RateRow }) {
  const key = rate?.id ?? "new";
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Name" name={`name-${key}`}>
        <input
          id={`name-${key}`}
          name="name"
          required
          defaultValue={rate?.name}
          className={inputClass}
        />
      </Field>
      <Field label="From (first night)" name={`startsOn-${key}`}>
        <input
          id={`startsOn-${key}`}
          name="startsOn"
          type="date"
          required
          defaultValue={rate?.startsOn}
          className={inputClass}
        />
      </Field>
      <Field label="Until (not including)" name={`endsOn-${key}`}>
        <input
          id={`endsOn-${key}`}
          name="endsOn"
          type="date"
          required
          defaultValue={rate?.endsOn}
          className={inputClass}
        />
      </Field>
      <Field label="Nightly rate (£)" name={`nightly-${key}`}>
        <input
          id={`nightly-${key}`}
          name="nightly"
          inputMode="decimal"
          required
          defaultValue={rate ? penceToPounds(rate.nightlyMinor) : ""}
          className={inputClass}
        />
      </Field>
      <Field label="Fri/Sat rate (£, optional)" name={`weekendNightly-${key}`}>
        <input
          id={`weekendNightly-${key}`}
          name="weekendNightly"
          inputMode="decimal"
          defaultValue={
            rate?.weekendNightlyMinor != null
              ? penceToPounds(rate.weekendNightlyMinor)
              : ""
          }
          className={inputClass}
        />
      </Field>
      <Field label="Minimum nights (optional)" name={`minNights-${key}`}>
        <input
          id={`minNights-${key}`}
          name="minNights"
          inputMode="numeric"
          defaultValue={rate?.minNights ?? ""}
          className={inputClass}
        />
      </Field>
      <Field
        label="Priority"
        name={`priority-${key}`}
        hint="Higher wins where rates overlap."
      >
        <input
          id={`priority-${key}`}
          name="priority"
          inputMode="numeric"
          defaultValue={rate?.priority ?? 0}
          className={inputClass}
        />
      </Field>
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="text-sm font-semibold text-pine-900">
          Arrival days (leave all unticked for any day)
        </legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {WEEKDAYS.map((label, i) => (
            <label key={label} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                name="arrivalDays"
                value={i + 1}
                defaultChecked={rate?.allowedArrivalWeekdays?.includes(i + 1)}
                className="size-5"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

async function Pricing({
  searchParams,
}: {
  searchParams: PageProps<"/admin/pricing">["searchParams"];
}) {
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const { rates, fees, policy } = await pricingOverview(
    ctx.db,
    ctx.property.id,
  );

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        saved={typeof saved === "string" ? saved : undefined}
        error={typeof error === "string" ? error : undefined}
      />
      <p className="text-ink-muted">
        Changes apply to new quotes straight away. Existing bookings keep the
        price agreed when they were made.
      </p>

      <AdminSection id="rates" title="Nightly rates">
        {rates.length === 0 && (
          <p className="mb-4">
            No rates yet: no dates can be booked until a rate covers them.
          </p>
        )}
        <ul className="space-y-4">
          {rates.map((r) => (
            <li key={r.id} className="rounded-soft border border-sage-300 p-4">
              <p className="font-semibold">
                {r.name} · {formatStayDate(r.startsOn as IsoDate)} –{" "}
                {formatStayDate(r.endsOn as IsoDate)} ·{" "}
                {formatMoney(r.nightlyMinor)}
                {r.weekendNightlyMinor != null
                  ? ` (Fri/Sat ${formatMoney(r.weekendNightlyMinor)})`
                  : ""}{" "}
                · {r.active ? "on" : "off"} · v{r.version}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm font-semibold text-pine-800 underline underline-offset-4">
                  Edit
                </summary>
                <form action={updateRateRuleAction} className="mt-3 space-y-4">
                  <input type="hidden" name="id" value={r.id} />
                  <RateFields rate={r} />
                  <button type="submit" className={primaryButton}>
                    Save rate
                  </button>
                </form>
              </details>
              <form action={toggleRateRuleAction} className="mt-2">
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="active" value={String(!r.active)} />
                <button type="submit" className={smallButton}>
                  {r.active ? "Switch off" : "Switch on"}
                </button>
              </form>
            </li>
          ))}
        </ul>
        <details className="mt-6" open={rates.length === 0}>
          <summary className="cursor-pointer font-semibold text-pine-800 underline underline-offset-4">
            Add a rate
          </summary>
          <form action={createRateRuleAction} className="mt-4 space-y-4">
            <RateFields />
            <button type="submit" className={primaryButton}>
              Add rate
            </button>
          </form>
        </details>
      </AdminSection>

      <AdminSection id="fees" title="Fees">
        <ul className="divide-y divide-sage-300/70">
          {fees.map((f) => (
            <li
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span>
                <strong>{f.name}</strong> · {FEE_KIND[f.kind]} ·{" "}
                {f.kind === "PERCENT_OF_ACCOMMODATION"
                  ? `${(f.basisPoints ?? 0) / 100}%`
                  : formatMoney(f.amountMinor ?? 0)}
                {f.appliesAboveGuests != null
                  ? ` above ${f.appliesAboveGuests} guests`
                  : ""}{" "}
                · {TAX[f.taxTreatment]} · {f.active ? "on" : "off"}
              </span>
              <form action={toggleFeeRuleAction}>
                <input type="hidden" name="id" value={f.id} />
                <input type="hidden" name="active" value={String(!f.active)} />
                <button type="submit" className={smallButton}>
                  {f.active ? "Switch off" : "Switch on"}
                </button>
              </form>
            </li>
          ))}
        </ul>
        <details className="mt-6">
          <summary className="cursor-pointer font-semibold text-pine-800 underline underline-offset-4">
            Add a fee
          </summary>
          <form
            action={createFeeRuleAction}
            className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <Field label="Name (shown to guests)" name="fee-name">
              <input
                id="fee-name"
                name="name"
                required
                className={inputClass}
              />
            </Field>
            <Field label="Type" name="fee-kind">
              <select id="fee-kind" name="kind" className={inputClass}>
                {Object.entries(FEE_KIND).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Amount (£)"
              name="fee-amount"
              hint="For all types except percentage."
            >
              <input
                id="fee-amount"
                name="amount"
                inputMode="decimal"
                className={inputClass}
              />
            </Field>
            <Field
              label="Percentage"
              name="fee-percent"
              hint="Only for % of accommodation."
            >
              <input
                id="fee-percent"
                name="percent"
                inputMode="decimal"
                className={inputClass}
              />
            </Field>
            <Field
              label="Guests included"
              name="fee-above"
              hint="Extra-guest fees apply above this number."
            >
              <input
                id="fee-above"
                name="appliesAboveGuests"
                inputMode="numeric"
                className={inputClass}
              />
            </Field>
            <Field
              label="Tax treatment"
              name="fee-tax"
              hint="Confirm with your accountant."
            >
              <select id="fee-tax" name="taxTreatment" className={inputClass}>
                {Object.entries(TAX).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2 lg:col-span-3">
              <button type="submit" className={primaryButton}>
                Add fee
              </button>
            </div>
          </form>
        </details>
      </AdminSection>

      <AdminSection id="policy" title="Payment plan">
        <p>
          Guests pay the <strong>full amount when they book</strong>. The
          booking is confirmed once Stripe verifies the payment. Deposit plans
          are switched off for instant booking.
        </p>
        {!policy && (
          <form action={savePaymentPolicyAction} className="mt-4">
            <input type="hidden" name="mode" value="FULL" />
            <p className="mb-3 text-sm text-ink-muted">
              No payment plan is saved yet, so bookings can&rsquo;t be taken.
            </p>
            <button type="submit" className={primaryButton}>
              Use full payment when booking
            </button>
          </form>
        )}
      </AdminSection>
    </div>
  );
}
