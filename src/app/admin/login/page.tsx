import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable, getAdmin } from "@/server/admin/auth";
import { signInAction } from "../auth-actions";
import { LoginForm } from "../auth-forms";
import type { AuthFormState } from "../auth-state";
import { AuthPage, Unavailable } from "../auth-ui";

export const metadata = { title: "Sign in" };

const NOTICES: Record<string, AuthFormState> = {
  expired: {
    status: "error",
    message:
      "That sign-in wasn’t finished within 10 minutes, so it was cancelled for your safety. Please sign in again.",
  },
  origin: {
    status: "error",
    message:
      "That request couldn’t be verified, so nothing was changed. Please sign in again from this page.",
  },
  reset: {
    status: "info",
    message: "Your password has been changed. Sign in with your new password.",
  },
};

export default function LoginPage({ searchParams }: PageProps<"/admin/login">) {
  return (
    <AuthPage title="Owner sign-in">
      <Suspense fallback={null}>
        <Login searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function Login({
  searchParams,
}: {
  searchParams: PageProps<"/admin/login">["searchParams"];
}) {
  const { error, notice } = await searchParams;
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  const key =
    typeof notice === "string"
      ? notice
      : typeof error === "string"
        ? error
        : "";
  // Already signed in (e.g. a duplicate tap finished the sign-in): go on,
  // unless this page is explaining a refused request.
  if (key !== "origin" && (await getAdmin())) redirect("/admin");
  return (
    <>
      <LoginForm
        action={signInAction}
        initial={NOTICES[key] ?? { status: "idle" }}
      />
      <p className="mt-5 text-sm text-ink-muted">
        You&rsquo;ll be asked for a code from your authenticator app next.
      </p>
      <p className="mt-3 text-sm">
        <Link
          href="/admin/forgot"
          className="font-semibold text-pine-900 underline underline-offset-4"
        >
          Forgotten your password?
        </Link>
      </p>
    </>
  );
}
