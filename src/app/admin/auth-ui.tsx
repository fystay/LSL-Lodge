import type { ReactNode } from "react";

/** Shared pieces for the sign-in pages (server-rendered; no client JS needed). */

export const authInput =
  "mt-1.5 block min-h-12 w-full rounded-soft border border-sage-600/60 bg-ivory px-3";
export const authButton =
  "min-h-12 rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700";

export function AuthPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-4 py-16">
      <h1 className="text-title">{title}</h1>
      {children}
    </main>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-6 rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger"
    >
      {children}
    </p>
  );
}

export function Unavailable() {
  return (
    <p
      role="status"
      className="mt-6 rounded-soft border border-notice-ink/30 bg-notice p-4 text-notice-ink"
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
        Or enter one of your recovery codes.
      </p>
    </div>
  );
}
