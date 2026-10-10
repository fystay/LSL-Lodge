import { connection } from "next/server";
import { Suspense } from "react";
import { requireAdmin } from "@/server/admin/auth";
import { reauthAction } from "../auth-actions";
import { CodeForm } from "../auth-forms";
import { AuthPage } from "../auth-ui";

export const metadata = { title: "Confirm it’s you" };

export default function ReauthPage({
  searchParams,
}: PageProps<"/admin/reauth">) {
  return (
    <AuthPage
      title="Confirm it’s you"
      intro="This change affects prices, payments, settings or calendar links, so please enter a fresh code. You won’t be asked again for 15 minutes."
    >
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
  const { next } = await searchParams;
  await connection();
  await requireAdmin("view");
  return (
    <>
      <CodeForm
        action={reauthAction}
        initial={{ status: "idle" }}
        hidden={{ next: typeof next === "string" ? next : "/admin" }}
        submitLabel="Confirm"
        busyLabel="Checking…"
      />
      <p className="mt-4 text-sm text-ink-muted">
        After confirming, submit your change again.
      </p>
    </>
  );
}
