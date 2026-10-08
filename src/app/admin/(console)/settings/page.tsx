import { Suspense } from "react";
import {
  AdminSection,
  Field,
  FormStatus,
  NotReady,
  inputClass,
  primaryButton,
} from "@/components/admin-ui";
import { adminContext } from "@/server/admin/context";
import { updateSettingsAction } from "../../actions";

export const metadata = { title: "Settings" };

export default function SettingsPage({
  searchParams,
}: PageProps<"/admin/settings">) {
  return (
    <>
      <h1 className="text-title">Settings</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Settings searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Settings({
  searchParams,
}: {
  searchParams: PageProps<"/admin/settings">["searchParams"];
}) {
  const { saved, error } = await searchParams;
  const ctx = await adminContext();
  if (!ctx.ready)
    return (
      <div className="mt-6">
        <NotReady reason={ctx.reason} />
      </div>
    );
  const p = ctx.property;

  return (
    <div className="mt-6 space-y-6">
      <FormStatus
        saved={typeof saved === "string" ? saved : undefined}
        error={typeof error === "string" ? error : undefined}
      />
      <AdminSection id="stay-rules" title="Stay rules">
        <form
          action={updateSettingsAction}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="Maximum guests" name="maxGuests">
            <input
              id="maxGuests"
              name="maxGuests"
              inputMode="numeric"
              required
              defaultValue={p.maxGuests}
              className={inputClass}
            />
          </Field>
          <Field
            label="Minimum stay (nights)"
            name="defaultMinNights"
            hint="Rates can require longer stays."
          >
            <input
              id="defaultMinNights"
              name="defaultMinNights"
              inputMode="numeric"
              required
              defaultValue={p.defaultMinNights}
              className={inputClass}
            />
          </Field>
          <Field
            label="Changeover nights"
            name="turnoverNights"
            hint="0 allows check-out and check-in on the same day."
          >
            <input
              id="turnoverNights"
              name="turnoverNights"
              inputMode="numeric"
              defaultValue={p.turnoverNights}
              className={inputClass}
            />
          </Field>
          <Field label="Bookable ahead (days)" name="bookingHorizonDays">
            <input
              id="bookingHorizonDays"
              name="bookingHorizonDays"
              inputMode="numeric"
              required
              defaultValue={p.bookingHorizonDays}
              className={inputClass}
            />
          </Field>
          <Field label="Check-in from (HH:MM)" name="checkInTime">
            <input
              id="checkInTime"
              name="checkInTime"
              defaultValue={
                p.checkInTime && /^\d\d:\d\d$/.test(p.checkInTime)
                  ? p.checkInTime
                  : ""
              }
              className={inputClass}
            />
          </Field>
          <Field label="Check-out by (HH:MM)" name="checkOutTime">
            <input
              id="checkOutTime"
              name="checkOutTime"
              defaultValue={
                p.checkOutTime && /^\d\d:\d\d$/.test(p.checkOutTime)
                  ? p.checkOutTime
                  : ""
              }
              className={inputClass}
            />
          </Field>
          <label className="flex min-h-11 items-center gap-3 sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              name="bookingsEnabled"
              defaultChecked={p.bookingsEnabled}
              className="size-5"
            />
            <span>
              <strong>Accept online bookings</strong> (only takes effect where
              the booking flow is switched on for the site; live payments also
              need your separate approval)
            </span>
          </label>
          <div className="sm:col-span-2 lg:col-span-3">
            <button type="submit" className={primaryButton}>
              Save settings
            </button>
          </div>
        </form>
      </AdminSection>
    </div>
  );
}
