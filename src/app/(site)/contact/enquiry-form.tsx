"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import type { EnquiryField, EnquiryState } from "@/server/contact/enquiry";
import { submitEnquiry } from "./actions";

const labels: Record<EnquiryField, string> = {
  name: "Your name",
  email: "Email address",
  message: "Message",
};

export function EnquiryForm() {
  const [state, action, pending] = useActionState(submitEnquiry, {
    status: "idle",
  } as EnquiryState);
  const id = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const values = "values" in state ? state.values : undefined;
  const errors = (state.status === "invalid" && state.errors) || {};
  const errorEntries = Object.entries(errors) as [EnquiryField, string][];

  // Move focus to the outcome so keyboard and screen-reader users hear it.
  useEffect(() => {
    if (state.status !== "idle") summaryRef.current?.focus();
  }, [state]);

  if (state.status === "sent") {
    return (
      <div
        ref={summaryRef}
        tabIndex={-1}
        role="status"
        className="rounded-soft border border-success/40 bg-sage-100 p-6"
      >
        <p className="font-semibold text-success">
          Thank you, your message has been sent.
        </p>
        <p className="mt-1">The owner will reply by email.</p>
      </div>
    );
  }

  return (
    <form
      action={action}
      noValidate
      className="space-y-5"
      aria-describedby={`${id}-privacy`}
    >
      <div
        ref={summaryRef}
        tabIndex={-1}
        aria-live="polite"
        className="outline-none"
      >
        {state.status === "invalid" && errorEntries.length > 0 && (
          <div
            className="rounded-soft border border-danger/40 bg-ivory p-4"
            role="alert"
          >
            <p className="font-semibold text-danger">
              Please check the following:
            </p>
            <ul className="mt-2 list-disc pl-5">
              {errorEntries.map(([field, message]) => (
                <li key={field}>
                  <a href={`#${id}-${field}`} className="text-danger underline">
                    {message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.status === "unavailable" && (
          <div
            className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
            role="alert"
          >
            <p className="font-semibold">
              The enquiry form isn&rsquo;t connected yet.
            </p>
            <p className="mt-1">
              Your message has <strong>not</strong> been sent. Email delivery is
              being set up; your text is still below so nothing is lost.
            </p>
          </div>
        )}
        {state.status === "error" && (
          <div
            className="rounded-soft border border-danger/40 bg-ivory p-4"
            role="alert"
          >
            <p className="font-semibold text-danger">
              Sorry, your message could not be sent. Please try again later.
            </p>
          </div>
        )}
      </div>

      {(["name", "email"] as const).map((field) => (
        <div key={field}>
          <label
            htmlFor={`${id}-${field}`}
            className="font-semibold text-pine-900"
          >
            {labels[field]}
          </label>
          <input
            id={`${id}-${field}`}
            name={field}
            type={field === "email" ? "email" : "text"}
            autoComplete={field === "email" ? "email" : "name"}
            required
            defaultValue={values?.[field]}
            aria-invalid={errors[field] ? true : undefined}
            aria-describedby={
              errors[field] ? `${id}-${field}-error` : undefined
            }
            className={`mt-1.5 block min-h-12 w-full rounded-soft border bg-ivory px-3 ${errors[field] ? "border-danger" : "border-sage-600/60"}`}
          />
          {errors[field] && (
            <p
              id={`${id}-${field}-error`}
              className="mt-1 text-sm font-medium text-danger"
            >
              {errors[field]}
            </p>
          )}
        </div>
      ))}

      <div>
        <label
          htmlFor={`${id}-message`}
          className="font-semibold text-pine-900"
        >
          {labels.message}
        </label>
        <textarea
          id={`${id}-message`}
          name="message"
          rows={6}
          required
          defaultValue={values?.message}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? `${id}-message-error` : undefined}
          className={`mt-1.5 block w-full rounded-soft border bg-ivory px-3 py-2 ${errors.message ? "border-danger" : "border-sage-600/60"}`}
        />
        {errors.message && (
          <p
            id={`${id}-message-error`}
            className="mt-1 text-sm font-medium text-danger"
          >
            {errors.message}
          </p>
        )}
      </div>

      {/* Honeypot, hidden from people and assistive technology. */}
      <div
        aria-hidden="true"
        className="absolute -left-[9999px] h-px w-px overflow-hidden"
      >
        <label>
          Leave this empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <p id={`${id}-privacy`} className="text-sm text-ink-muted">
        We use your details only to reply to you. See the{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          privacy notice
        </Link>
        .
      </p>

      <button
        type="submit"
        disabled={pending}
        className="min-h-12 rounded-soft bg-pine-800 px-6 font-semibold text-ivory transition-colors hover:bg-pine-700 disabled:opacity-70"
      >
        {pending ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
