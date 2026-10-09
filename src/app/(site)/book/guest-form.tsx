"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import type { GuestField, HoldFormState } from "@/server/booking/guest-details";
import { placeHold } from "./actions";

export function GuestForm({
  mode,
  stay,
}: {
  mode: "REQUEST" | "INSTANT";
  stay: {
    checkIn: string;
    checkOut: string;
    guests: number;
    idempotencyKey: string;
  };
}) {
  const [state, action, pending] = useActionState(placeHold, {
    status: "idle",
  } as HoldFormState);
  const id = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const values = "values" in state ? state.values : undefined;
  const errors = (state.status === "invalid" && state.errors) || {};

  useEffect(() => {
    if (state.status !== "idle") summaryRef.current?.focus();
  }, [state]);

  const field = (
    name: Exclude<GuestField, "acceptTerms">,
    label: string,
    extra: object = {},
  ) => (
    <div>
      <label htmlFor={`${id}-${name}`} className="font-semibold text-pine-900">
        {label}
      </label>
      <input
        id={`${id}-${name}`}
        name={name}
        defaultValue={values?.[name]}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
        className={`mt-1.5 block min-h-12 w-full rounded-soft border bg-ivory px-3 ${errors[name] ? "border-danger" : "border-sage-600/60"}`}
        {...extra}
      />
      {errors[name] && (
        <p
          id={`${id}-${name}-error`}
          className="mt-1 text-sm font-medium text-danger"
        >
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form action={action} noValidate className="space-y-5">
      <input type="hidden" name="checkIn" value={stay.checkIn} />
      <input type="hidden" name="checkOut" value={stay.checkOut} />
      <input type="hidden" name="guests" value={stay.guests} />
      <input type="hidden" name="idempotencyKey" value={stay.idempotencyKey} />

      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {state.status !== "idle" && (
          <div
            role="alert"
            className="rounded-soft border border-danger/40 bg-ivory p-4"
          >
            {state.status === "invalid" ? (
              <>
                <p className="font-semibold text-danger">
                  Please check the following:
                </p>
                <ul className="mt-2 list-disc pl-5">
                  {Object.entries(errors).map(([name, message]) => (
                    <li key={name}>
                      <a
                        href={`#${id}-${name}`}
                        className="text-danger underline"
                      >
                        {message}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="font-semibold text-danger">
                {state.message}{" "}
                {state.status === "unavailable" && (
                  <Link href="/availability" className="underline">
                    Search other dates
                  </Link>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {field("name", "Lead guest name", {
        autoComplete: "name",
        required: true,
      })}
      {field("email", "Email address", {
        type: "email",
        autoComplete: "email",
        required: true,
      })}
      <div>
        {field("phone", "Phone number (optional)", {
          type: "tel",
          autoComplete: "tel",
        })}
        <p className="mt-1 text-sm text-ink-muted">
          Only used if we need to reach you about your arrival.
        </p>
      </div>

      <div>
        <div className="flex items-start gap-3">
          <input
            id={`${id}-acceptTerms`}
            name="acceptTerms"
            type="checkbox"
            required
            aria-invalid={errors.acceptTerms ? true : undefined}
            aria-describedby={
              errors.acceptTerms ? `${id}-acceptTerms-error` : undefined
            }
            className="mt-1 size-5 accent-pine-800"
          />
          <label htmlFor={`${id}-acceptTerms`}>
            I have read the{" "}
            <Link href="/terms" className="underline underline-offset-4">
              booking terms
            </Link>{" "}
            and{" "}
            <Link
              href="/cancellation-policy"
              className="underline underline-offset-4"
            >
              cancellation policy
            </Link>
            .
          </label>
        </div>
        {errors.acceptTerms && (
          <p
            id={`${id}-acceptTerms-error`}
            className="mt-1 text-sm font-medium text-danger"
          >
            {errors.acceptTerms}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="min-h-12 w-full rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700 disabled:opacity-70 sm:w-auto"
      >
        {mode === "REQUEST"
          ? pending
            ? "Sending your request…"
            : "Send booking request"
          : pending
            ? "Holding your dates…"
            : "Hold these dates"}
      </button>
    </form>
  );
}
