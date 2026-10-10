"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { enrolAction, type EnrolState } from "../auth-actions";
import { PasswordField } from "../auth-forms";
import { authButton, authInput } from "../auth-ui";

export function EnrolForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(enrolAction, {
    status: "idle",
  } as EnrolState);
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status !== "idle") focusRef.current?.focus();
  }, [state]);

  if (state.status === "done")
    return (
      <div
        ref={focusRef}
        tabIndex={-1}
        role="status"
        className="space-y-3 outline-none"
      >
        <h2 className="text-xl">Your account is ready</h2>
        <p>
          Keep these recovery codes somewhere safe and private. Each works once,
          if you lose your phone. They won&rsquo;t be shown again.
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-soft bg-mist p-3 font-mono">
          {state.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Link
          href="/admin/login"
          className="font-semibold underline underline-offset-4"
        >
          Continue to sign in
        </Link>
      </div>
    );

  return (
    <form action={action} className="space-y-5">
      <h2 className="text-xl">2. Choose a password and confirm the code</h2>
      <input type="hidden" name="token" value={token} />
      <div ref={focusRef} tabIndex={-1} className="outline-none">
        {state.status === "error" && (
          <p
            role="alert"
            className="rounded-soft border border-danger/40 bg-ivory p-3 font-medium text-danger"
          >
            {state.message}
          </p>
        )}
      </div>
      <PasswordField
        label="New password"
        autoComplete="new-password"
        minLength={12}
        describedBy="password-hint"
      />
      <p id="password-hint" className="-mt-3 text-sm text-ink-muted">
        At least 12 characters. A few unrelated words works well.
      </p>
      <PasswordField
        id="confirm"
        name="confirm"
        label="Repeat the password"
        autoComplete="new-password"
      />
      <div>
        <label htmlFor="code" className="font-semibold text-pine-900">
          Current code from the app
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={8}
          className={authInput}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className={`${authButton} w-full disabled:cursor-wait disabled:opacity-70`}
      >
        {pending ? "Setting up…" : "Finish set-up"}
      </button>
    </form>
  );
}
