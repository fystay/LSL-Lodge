import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { passwordResetValid } from "@/server/admin/accounts";
import { adminAvailable } from "@/server/admin/auth";
import { db } from "@/server/db/client";
import { resetPasswordAction } from "../auth-actions";
import { ResetForm } from "../auth-forms";
import { AuthError, AuthPage, Unavailable } from "../auth-ui";

export const metadata = {
  title: "Choose a new password",
  // The link carries a one-time token: don't send it anywhere else.
  referrer: "no-referrer" as const,
};

export default function ResetPage({ searchParams }: PageProps<"/admin/reset">) {
  return (
    <AuthPage title="Choose a new password">
      <Suspense fallback={null}>
        <Reset searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function Reset({
  searchParams,
}: {
  searchParams: PageProps<"/admin/reset">["searchParams"];
}) {
  const { t } = await searchParams;
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  const token = typeof t === "string" ? t : "";
  if (!(await passwordResetValid(db(), token)))
    return (
      <>
        <AuthError>
          This reset link is invalid, already used or expired. Links work once,
          for 30 minutes.
        </AuthError>
        <p className="mt-5 text-sm">
          <Link
            href="/admin/forgot"
            className="font-semibold text-pine-900 underline underline-offset-4"
          >
            Ask for a new link
          </Link>
        </p>
      </>
    );
  return (
    <>
      <ResetForm action={resetPasswordAction} token={token} />
      <p className="mt-5 text-sm text-ink-muted">
        Changing your password signs you out everywhere. You&rsquo;ll still need
        your authenticator app to sign in.
      </p>
    </>
  );
}
