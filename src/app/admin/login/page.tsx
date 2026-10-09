import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable } from "@/server/admin/auth";
import { signInAction } from "../auth-actions";
import {
  AuthError,
  AuthPage,
  Unavailable,
  authButton,
  authInput,
} from "../auth-ui";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  "1": "Those details weren’t recognised, or the account is temporarily locked after too many attempts. Try again later.",
  expired: "Your sign-in took too long. Please start again.",
  origin:
    "That request couldn’t be verified. Please sign in again from this page.",
};

export default function LoginPage({ searchParams }: PageProps<"/admin/login">) {
  return (
    <AuthPage title="Owner sign-in">
      <Suspense fallback={null}>
        <LoginForm searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function LoginForm({
  searchParams,
}: {
  searchParams: PageProps<"/admin/login">["searchParams"];
}) {
  const { error } = await searchParams;
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  return (
    <>
      {typeof error === "string" && ERRORS[error] && (
        <AuthError>{ERRORS[error]}</AuthError>
      )}
      <form action={signInAction} className="mt-8 space-y-5">
        <div>
          <label htmlFor="email" className="font-semibold text-pine-900">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className={authInput}
          />
        </div>
        <div>
          <label htmlFor="password" className="font-semibold text-pine-900">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={authInput}
          />
        </div>
        <button type="submit" className={authButton}>
          Continue
        </button>
        <p className="text-sm text-ink-muted">
          You&rsquo;ll be asked for a code from your authenticator app next.
        </p>
      </form>
    </>
  );
}
