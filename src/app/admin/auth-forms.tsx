"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { AuthFormState } from "./auth-state";
import { authButton, authInput, authInputBase } from "./auth-ui";

/**
 * Sign-in forms for phones: each submits at most once at a time (the
 * button disables while the server works, and a second tap or Enter is
 * ignored), errors appear in place without clearing the email address,
 * and the password can be shown.
 */

type Action = (state: AuthFormState, form: FormData) => Promise<AuthFormState>;

function useSingleSubmit(action: Action, initial: AuthFormState) {
  const [state, formAction, pending] = useActionState(action, initial);
  const busy = useRef(false);
  useEffect(() => {
    if (!pending) busy.current = false;
  }, [pending]);
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // Belt and braces: React already queues actions, but a double tap must
    // never reach the server twice (each code works only once).
    if (busy.current) event.preventDefault();
    else busy.current = true;
  };
  return { state, formAction, pending, onSubmit };
}

function Submit({ label, busyLabel }: { label: string; busyLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${authButton} w-full disabled:cursor-wait disabled:opacity-70`}
      disabled={pending}
      aria-disabled={pending}
    >
      {pending ? busyLabel : label}
    </button>
  );
}

function Message({ state }: { state: AuthFormState }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.message) ref.current?.focus();
  }, [state]);
  if (!state.message) return null;
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role={state.status === "error" ? "alert" : "status"}
      className={
        state.status === "error"
          ? "rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger outline-none"
          : "rounded-soft border border-success/40 bg-sage-100 p-3 font-medium text-success outline-none"
      }
    >
      {state.message}
    </p>
  );
}

export function PasswordField({
  id = "password",
  name = "password",
  label = "Password",
  autoComplete = "current-password",
  minLength,
  describedBy,
}: {
  id?: string;
  name?: string;
  label?: string;
  autoComplete?: string;
  minLength?: number;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <label htmlFor={id} className="font-semibold text-pine-900">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          ref={input}
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          minLength={minLength}
          aria-describedby={describedBy}
          className={`${authInputBase} pr-20`}
        />
        <button
          type="button"
          onClick={() => {
            setShown((v) => !v);
            input.current?.focus();
          }}
          aria-controls={id}
          aria-pressed={shown}
          aria-label={
            shown
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
          className="absolute inset-y-0 right-0 min-w-16 rounded-r-soft px-3 text-sm font-semibold text-pine-900 underline underline-offset-4"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export function LoginForm({
  action,
  initial,
}: {
  action: Action;
  initial: AuthFormState;
}) {
  const { state, formAction, onSubmit } = useSingleSubmit(action, initial);
  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className="space-y-5"
      noValidate={false}
    >
      <Message state={state} />
      <div>
        <label htmlFor="email" className="font-semibold text-pine-900">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={state.email ?? ""}
          key={state.email ?? ""}
          className={authInput}
        />
      </div>
      <PasswordField />
      <Submit label="Continue" busyLabel="Checking…" />
    </form>
  );
}

export function CodeForm({
  action,
  initial,
  hidden,
  submitLabel = "Sign in",
  busyLabel = "Signing in…",
}: {
  action: Action;
  initial: AuthFormState;
  hidden?: Record<string, string>;
  submitLabel?: string;
  busyLabel?: string;
}) {
  const { state, formAction, onSubmit } = useSingleSubmit(action, initial);
  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-5">
      <Message state={state} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div>
        <label htmlFor="code" className="font-semibold text-pine-900">
          Code from your authenticator app
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={20}
          aria-describedby="code-hint"
          className={`${authInput} text-center text-2xl tracking-[0.3em] tabular-nums`}
        />
        <p id="code-hint" className="mt-2 text-sm text-ink-muted">
          No rush: this page waits 10 minutes, and a code still works for 30
          seconds after your app shows the next one. Each code works once. You
          can also enter one of your recovery codes.
        </p>
      </div>
      <Submit label={submitLabel} busyLabel={busyLabel} />
    </form>
  );
}

export function ForgotForm({ action }: { action: Action }) {
  const { state, formAction, onSubmit } = useSingleSubmit(action, {
    status: "idle",
  });
  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-5">
      <Message state={state} />
      <div>
        <label htmlFor="email" className="font-semibold text-pine-900">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={state.email ?? ""}
          key={state.email ?? ""}
          className={authInput}
        />
      </div>
      <Submit label="Send reset link" busyLabel="Sending…" />
    </form>
  );
}

export function ResetForm({
  action,
  token,
}: {
  action: Action;
  token: string;
}) {
  const { state, formAction, onSubmit } = useSingleSubmit(action, {
    status: "idle",
  });
  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-5">
      <Message state={state} />
      <input type="hidden" name="token" value={token} />
      <PasswordField
        label="New password"
        autoComplete="new-password"
        minLength={12}
        describedBy="new-password-hint"
      />
      <p id="new-password-hint" className="-mt-3 text-sm text-ink-muted">
        At least 12 characters. A few unrelated words works well.
      </p>
      <PasswordField
        id="confirm"
        name="confirm"
        label="Repeat the new password"
        autoComplete="new-password"
      />
      <Submit label="Change password" busyLabel="Saving…" />
    </form>
  );
}
