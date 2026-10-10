import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable } from "@/server/admin/auth";
import { requestPasswordResetAction } from "../auth-actions";
import { ForgotForm } from "../auth-forms";
import { AuthPage, Unavailable } from "../auth-ui";

export const metadata = { title: "Reset your password" };

export default function ForgotPage() {
  return (
    <AuthPage
      title="Reset your password"
      intro="Enter your owner email address. If it belongs to an owner account, we’ll email a link to choose a new password."
    >
      <Suspense fallback={null}>
        <Forgot />
      </Suspense>
    </AuthPage>
  );
}

async function Forgot() {
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  return (
    <>
      <ForgotForm action={requestPasswordResetAction} />
      <p className="mt-5 text-sm text-ink-muted">
        Your authenticator app is still needed to sign in. Lost it too? Use one
        of your recovery codes, or ask whoever manages the site for a new set-up
        link.
      </p>
      <p className="mt-3 text-sm">
        <Link
          href="/admin/login"
          className="font-semibold text-pine-900 underline underline-offset-4"
        >
          Back to sign-in
        </Link>
      </p>
    </>
  );
}
