"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { addDays, isIsoDate, todayInTimeZone, type IsoDate } from "@/lib/dates";
import type { SearchField } from "@/lib/stay-search";

/**
 * Date and guest search. A plain GET form, so it works without JavaScript; the
 * script only keeps the check-out minimum in step with check-in. Native date
 * inputs give an accessible, localised picker on every platform. The server
 * re-validates everything.
 */
export function BookingSearch({
  maxGuests,
  minNights,
  timeZone,
  defaults = {},
  errors = [],
  variant = "panel",
}: {
  maxGuests: number;
  minNights: number;
  timeZone: string;
  defaults?: Partial<Record<SearchField, string>>;
  errors?: { field: SearchField; message: string }[];
  /** panel: wide bar; inline: no card; hero: compact card at the top of the homepage. */
  variant?: "panel" | "inline" | "hero";
}) {
  const id = useId();
  // "Today" is only known in the browser: the page itself is prerendered, so a
  // server-side value would be stale. Until hydration, no minimum is set.
  const today = useSyncExternalStore<IsoDate | null>(
    noopSubscribe,
    () => todayInTimeZone(timeZone),
    () => null,
  );
  const [checkIn, setCheckIn] = useState(defaults.checkIn ?? "");
  const errorFor = (field: SearchField) =>
    errors.find((e) => e.field === field)?.message;
  const minCheckOut = isIsoDate(checkIn)
    ? addDays(checkIn, minNights)
    : today
      ? addDays(today, minNights)
      : undefined;

  const fieldClass = (field: SearchField) =>
    `mt-1.5 block min-h-12 w-full rounded-soft border bg-ivory px-3 text-base text-ink ${
      errorFor(field) ? "border-danger" : "border-sage-600/60"
    }`;

  return (
    <form
      action="/availability"
      method="get"
      aria-label="Search dates"
      noValidate
      className={
        variant === "hero"
          ? "grid grid-cols-2 items-start gap-x-3 gap-y-4 rounded-2xl border border-sage-300/70 bg-ivory p-4 shadow-[0_24px_60px_-34px_rgba(20,39,31,0.6)] sm:gap-x-4 sm:p-6"
          : variant === "panel"
            ? "grid gap-4 rounded-soft bg-ivory p-5 shadow-[0_20px_50px_-30px_rgba(20,39,31,0.55)] sm:grid-cols-2 sm:p-6 lg:grid-cols-[1fr_1fr_0.8fr_auto] lg:items-start"
            : "grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.8fr_auto] lg:items-start"
      }
    >
      {variant === "hero" && (
        <p className="col-span-2 -mb-1 font-display text-xl text-pine-900 sm:text-2xl">
          Check availability
        </p>
      )}
      <div>
        <label
          htmlFor={`${id}-in`}
          className="text-sm font-semibold text-pine-900"
        >
          Check-in
        </label>
        <input
          id={`${id}-in`}
          name="checkIn"
          type="date"
          required
          min={today ?? undefined}
          value={checkIn}
          onChange={(e) => setCheckIn(e.target.value)}
          aria-invalid={errorFor("checkIn") ? true : undefined}
          aria-describedby={errorFor("checkIn") ? `${id}-in-error` : undefined}
          className={fieldClass("checkIn")}
        />
        <FieldError id={`${id}-in-error`} message={errorFor("checkIn")} />
      </div>
      <div>
        <label
          htmlFor={`${id}-out`}
          className="text-sm font-semibold text-pine-900"
        >
          Check-out
        </label>
        <input
          id={`${id}-out`}
          name="checkOut"
          type="date"
          required
          min={minCheckOut}
          defaultValue={defaults.checkOut}
          aria-invalid={errorFor("checkOut") ? true : undefined}
          aria-describedby={`${id}-out-hint${errorFor("checkOut") ? ` ${id}-out-error` : ""}`}
          className={fieldClass("checkOut")}
        />
        <p id={`${id}-out-hint`} className="mt-1 text-xs text-ink-muted">
          Minimum stay {minNights} nights
        </p>
        <FieldError id={`${id}-out-error`} message={errorFor("checkOut")} />
      </div>
      <div>
        <label
          htmlFor={`${id}-guests`}
          className="text-sm font-semibold text-pine-900"
        >
          Guests
        </label>
        <select
          id={`${id}-guests`}
          name="guests"
          required
          defaultValue={defaults.guests ?? "2"}
          aria-invalid={errorFor("guests") ? true : undefined}
          aria-describedby={
            errorFor("guests") ? `${id}-guests-error` : undefined
          }
          className={fieldClass("guests")}
        >
          {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "guest" : "guests"}
            </option>
          ))}
        </select>
        <FieldError id={`${id}-guests-error`} message={errorFor("guests")} />
      </div>
      <button
        type="submit"
        className={`min-h-12 rounded-soft bg-pine-800 px-4 font-semibold text-ivory transition-colors duration-200 hover:bg-pine-700 sm:px-6 ${
          variant === "hero"
            ? "mt-[1.625rem]"
            : "sm:col-span-2 lg:col-span-1 lg:mt-[1.625rem]"
        }`}
      >
        {variant === "hero" ? "Search" : "Check availability"}
      </button>
    </form>
  );
}

const noopSubscribe = () => () => {};

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm font-medium text-danger">
      {message}
    </p>
  );
}
