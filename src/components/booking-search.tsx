"use client";

import { useId, useState, useSyncExternalStore } from "react";
import {
  addDays,
  formatStayDate,
  isIsoDate,
  todayInTimeZone,
  type IsoDate,
} from "@/lib/dates";
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

  if (variant === "hero")
    return (
      <HeroSearch
        id={id}
        today={today}
        minNights={minNights}
        maxGuests={maxGuests}
        checkIn={checkIn}
        setCheckIn={setCheckIn}
        minCheckOut={minCheckOut}
        defaults={defaults}
        errorFor={errorFor}
      />
    );

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
        variant === "panel"
          ? "grid gap-4 rounded-soft bg-ivory p-5 shadow-[0_20px_50px_-30px_rgba(20,39,31,0.55)] sm:grid-cols-2 sm:p-6 lg:grid-cols-[1fr_1fr_0.8fr_auto] lg:items-start"
          : "grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.8fr_auto] lg:items-start"
      }
    >
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
        className="min-h-12 rounded-soft bg-pine-800 px-4 font-semibold text-ivory transition-colors duration-200 hover:bg-pine-700 sm:col-span-2 sm:px-6 lg:col-span-1 lg:mt-[1.625rem]"
      >
        Check availability
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

/**
 * The homepage card: icon-led date fields over native date inputs (so phones
 * still get their own accessible picker), a pill button, and the guest count
 * as a quiet footer line rather than a third box.
 */
function HeroSearch({
  id,
  today,
  minNights,
  maxGuests,
  checkIn,
  setCheckIn,
  minCheckOut,
  defaults,
  errorFor,
}: {
  id: string;
  today: IsoDate | null;
  minNights: number;
  maxGuests: number;
  checkIn: string;
  setCheckIn: (value: string) => void;
  minCheckOut: string | undefined;
  defaults: Partial<Record<SearchField, string>>;
  errorFor: (field: SearchField) => string | undefined;
}) {
  const [checkOut, setCheckOut] = useState(defaults.checkOut ?? "");
  return (
    <form
      action="/availability"
      method="get"
      aria-label="Search dates"
      noValidate
      className="rounded-3xl border border-sage-300/70 bg-ivory p-4 shadow-[0_24px_60px_-34px_rgba(20,39,31,0.6)] sm:p-7"
    >
      <p className="flex items-center gap-3 font-display text-2xl text-pine-900 sm:text-[1.75rem]">
        <CalendarIcon className="size-7 text-pine-800" />
        Check availability
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4">
        <HeroDateField
          id={`${id}-in`}
          name="checkIn"
          label="Check-in"
          value={checkIn}
          onChange={setCheckIn}
          min={today ?? undefined}
          error={errorFor("checkIn")}
          currentYear={today?.slice(0, 4)}
        />
        <HeroDateField
          id={`${id}-out`}
          name="checkOut"
          label="Check-out"
          value={checkOut}
          onChange={setCheckOut}
          min={minCheckOut}
          error={errorFor("checkOut")}
          describedBy={`${id}-out-hint`}
          currentYear={today?.slice(0, 4)}
        />
      </div>

      <p
        id={`${id}-out-hint`}
        className="mt-3 flex items-center gap-2.5 text-sm text-ink-muted"
      >
        <span aria-hidden="true" className="h-px w-5 bg-ink-muted/70" />
        Minimum stay: {minNights} nights
      </p>

      <button
        type="submit"
        className="mt-5 flex min-h-13 w-full items-center justify-center gap-3 rounded-full bg-pine-800 px-6 text-base font-semibold text-ivory transition-colors duration-200 hover:bg-pine-700"
      >
        Check availability
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 9h12M10.5 4.5 15 9l-4.5 4.5" />
        </svg>
      </button>

      {/* Guests as a quiet footer line between hairlines. */}
      <div className="mt-4 flex items-center gap-4">
        <span aria-hidden="true" className="h-px flex-1 bg-sage-300" />
        <div className="relative flex items-center gap-2 text-sm text-ink-muted">
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="7.5" cy="6.5" r="3" />
            <path d="M2 17c.6-3 2.8-4.5 5.5-4.5S12.4 14 13 17" />
            <path d="M13 3.8a3 3 0 0 1 0 5.4M15 12.8c1.6.6 2.6 2 3 4.2" />
          </svg>
          <label htmlFor={`${id}-guests`} className="sr-only">
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
            className="min-h-11 cursor-pointer appearance-none rounded-soft bg-transparent pr-4 font-semibold text-pine-900 underline decoration-sage-300 underline-offset-4"
          >
            {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "guest" : "guests"}
              </option>
            ))}
          </select>
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className="pointer-events-none -ml-3.5 text-pine-900"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m2 3.5 3 3 3-3" />
          </svg>
          <span>· sleeps up to {maxGuests}</span>
        </div>
        <span aria-hidden="true" className="h-px flex-1 bg-sage-300" />
      </div>
      <FieldError id={`${id}-guests-error`} message={errorFor("guests")} />
    </form>
  );
}

function HeroDateField({
  id,
  name,
  label,
  value,
  onChange,
  min,
  error,
  describedBy,
  currentYear,
}: {
  id: string;
  name: string;
  label: string;
  currentYear?: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  error?: string;
  describedBy?: string;
}) {
  // "12 Nov", or "12 Nov 2027" outside the current year; short enough for phones.
  const shown = isIsoDate(value)
    ? formatStayDate(value)
        .split(" ")
        .slice(1, value.slice(0, 4) === currentYear ? 3 : 4)
        .join(" ")
    : null;
  const describe =
    [describedBy, error ? `${id}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-sm font-semibold text-pine-900">
        {label}
      </label>
      {/* The native input sits invisibly on top, so a tap opens the
          platform's own date picker; the styled text below mirrors it. */}
      <div
        className={`relative mt-1.5 flex min-h-13 items-center gap-2 rounded-xl border bg-ivory px-3 transition-colors focus-within:border-pine-700 focus-within:ring-2 focus-within:ring-pine-700/25 sm:gap-2.5 sm:px-4 ${
          error ? "border-danger" : "border-sage-300 hover:border-sage-600/60"
        }`}
      >
        <CalendarIcon className="size-[1.125rem] shrink-0 text-pine-800 sm:size-5" />
        <span
          aria-hidden="true"
          className={`truncate text-[0.95rem] sm:text-base ${shown ? "text-ink" : "text-ink-muted"}`}
        >
          {shown ?? "Select date"}
        </span>
        <input
          id={id}
          name={name}
          type="date"
          required
          min={min}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => {
            // Desktop browsers open the calendar only from their own icon.
            try {
              e.currentTarget.showPicker();
            } catch {
              // Unsupported or not allowed here: the input still accepts typing.
            }
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describe}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={className}
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <path
        d="M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01"
        strokeWidth="2.2"
      />
    </svg>
  );
}
