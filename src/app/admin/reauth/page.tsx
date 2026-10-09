import { connection } from "next/server";
import { Suspense } from "react";
import { requireAdmin } from "@/server/admin/auth";
import { reauthAction } from "../auth-actions";
import { AuthError, AuthPage, CodeField, authButton } from "../auth-ui";

export const metadata = { title: "Confirm it’s you" };

export default function ReauthPage({
  searchParams,
}: PageProps<"/admin/reauth">) {
  return (
    <AuthPage title="Confirm it’s you">
      <Suspense fallback={null}>
        <ReauthForm searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function ReauthForm({
  searchParams,
}: {
  searchParams: PageProps<"/admin/reauth">["searchParams"];
}) {
  const { error, next } = await searchParams;
  await connection();
  await requireAdmin("view");
  return (
    <>
      <p className="mt-4">
        This change affects prices, payments, settings or calendar links, so
        please enter a fresh code. You won&rsquo;t be asked again for 15
        minutes.
      </p>
      {error && <AuthError>That code wasn&rsquo;t accepted.</AuthError>}
      <form action={reauthAction} className="mt-6 space-y-5">
        <input
          type="hidden"
          name="next"
          value={typeof next === "string" ? next : "/admin"}
        />
        <CodeField />
        <button type="submit" className={authButton}>
          Confirm
        </button>
      </form>
      <p className="mt-4 text-sm text-ink-muted">
        After confirming, submit your change again.
      </p>
    </>
  );
}
