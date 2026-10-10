import type { ReactNode } from "react";

/** Shared pieces for the sign-in pages (server-rendered; no client JS needed). */

export const authInputBase =
  "block min-h-12 w-full rounded-soft border border-sage-600/60 bg-ivory px-3 text-base focus-visible:border-pine-800";
export const authInput = `mt-1.5 ${authInputBase}`;
export const authButton =
  "min-h-12 rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700";

/**
 * A centred card on the ivory background: compact on a phone (no wasted
 * top space, full-width controls), the same identity as the public site.
 */
export function AuthPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex w-full flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-16"
    >
      <div className="w-full max-w-sm rounded-soft border border-sage-300 bg-ivory p-6 shadow-sm sm:p-8">
        <p className="font-display text-xl text-pine-900">Lodge on the Lake</p>
        <p className="text-xs font-semibold tracking-[0.18em] text-sage-600 uppercase">
          Owner area
        </p>
        <h1 className="mt-5 font-display text-3xl text-pine-900">{title}</h1>
        {intro && <div className="mt-2 text-ink-muted">{intro}</div>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger"
    >
      {children}
    </p>
  );
}

export function Unavailable() {
  return (
    <p
      role="status"
      className="rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
    >
      Admin sign-in isn&rsquo;t set up on this deployment (it needs the database
      and the credential encryption key).
    </p>
  );
}

export function CodeField({
  label = "Code from your authenticator app",
}: {
  label?: string;
}) {
  return (
    <div>
      <label htmlFor="code" className="font-semibold text-pine-900">
        {label}
      </label>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        maxLength={20}
        aria-describedby="code-hint"
        className={authInput}
      />
      <p id="code-hint" className="mt-1 text-sm text-ink-muted">
        No rush: this page waits 10 minutes, and a code still works for 30
        seconds after your app shows the next one. Or enter one of your recovery
        codes.
      </p>
    </div>
  );
}
