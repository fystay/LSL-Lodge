import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable } from "@/server/admin/auth";
import { verifySecondFactorAction } from "../../auth-actions";
import {
  AuthError,
  AuthPage,
  CodeField,
  Unavailable,
  authButton,
} from "../../auth-ui";

export const metadata = { title: "Verify sign-in" };

export default function VerifyPage({
  searchParams,
}: PageProps<"/admin/login/verify">) {
  return (
    <AuthPage title="Verify it’s you">
      <Suspense fallback={null}>
        <VerifyForm searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function VerifyForm({
  searchParams,
}: {
  searchParams: PageProps<"/admin/login/verify">["searchParams"];
}) {
  const { error } = await searchParams;
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  return (
    <>
      {error && (
        <AuthError>
          That code wasn&rsquo;t accepted. Codes work once; wait for the next
          one if you just used it.
        </AuthError>
      )}
      <form action={verifySecondFactorAction} className="mt-8 space-y-5">
        <CodeField />
        <button type="submit" className={authButton}>
          Sign in
        </button>
      </form>
    </>
  );
}
