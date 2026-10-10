import type { ReactNode } from "react";

/** Status line from a redirect after a form post (?saved / ?error). Text is our own. */
export function FormStatus({
  saved,
  error,
}: {
  saved?: string;
  error?: string;
}) {
  if (error)
    return (
      <p
        role="alert"
        className="rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger"
      >
        {error}
      </p>
    );
  if (saved)
    return (
      <p
        role="status"
        className="rounded-soft border border-success/40 bg-sage-100 p-3 font-medium text-success"
      >
        {saved}
      </p>
    );
  return null;
}

export function AdminSection({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-soft border border-sage-300 bg-ivory p-5 sm:p-6"
    >
      <h2 id={id} className="text-2xl">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  name,
  hint,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="text-sm font-semibold text-pine-900">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  "mt-1 block min-h-11 w-full rounded-soft border border-sage-600/60 bg-ivory px-3 text-base";

export const smallButton =
  "inline-flex min-h-11 items-center rounded-soft border border-pine-800 px-4 text-sm font-semibold text-pine-900 hover:bg-sage-100";

export const primaryButton =
  "inline-flex min-h-11 items-center rounded-soft bg-pine-800 px-5 text-sm font-semibold text-ivory hover:bg-pine-700";

export function NotReady({ reason }: { reason: string }) {
  return (
    <p
      role="status"
      className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
    >
      {reason} See README.md for local setup.
    </p>
  );
}

const statusTone: Record<string, string> = {
  // Legacy request-mode statuses (no new bookings use them).
  REQUESTED: "Request (legacy)",
  APPROVED: "Approved, awaiting payment (legacy)",
  DECLINED: "Declined (legacy)",
  CONFIRMED: "Confirmed",
  PAYMENT_DUE: "Balance due",
  PENDING_PAYMENT: "Awaiting payment (dates held)",
  REQUIRES_REVIEW: "Needs review",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REFUND_PENDING: "Cancelled, refund in progress",
  REFUNDED: "Cancelled and refunded",
};

export const statusLabel = (status: string) => statusTone[status] ?? status;
