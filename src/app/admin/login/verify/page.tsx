import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable, getAdmin } from "@/server/admin/auth";
import { verifySecondFactorAction } from "../../auth-actions";
import { CodeForm } from "../../auth-forms";
import { AuthPage, Unavailable } from "../../auth-ui";

export const metadata = { title: "Verify sign-in" };

export default function VerifyPage() {
  return (
    <AuthPage
      title="Enter your code"
      intro="Open your authenticator app and enter the 6-digit code for Lodge on the Lake."
    >
      <Suspense fallback={null}>
        <Verify />
      </Suspense>
    </AuthPage>
  );
}

async function Verify() {
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  if (await getAdmin()) redirect("/admin");
  return (
    <>
      <CodeForm
        action={verifySecondFactorAction}
        initial={{ status: "idle" }}
      />
      <p className="mt-5 text-sm">
        <Link
          href="/admin/login"
          className="font-semibold text-pine-900 underline underline-offset-4"
        >
          Start again
        </Link>
      </p>
    </>
  );
}
