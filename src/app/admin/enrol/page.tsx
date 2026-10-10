import { connection } from "next/server";
import { Suspense } from "react";
import { adminAvailable } from "@/server/admin/auth";
import { beginEnrolment } from "@/server/admin/accounts";
import { otpauthUri } from "@/server/admin/credentials";
import { credentialKeys } from "@/server/crypto/keys";
import { db } from "@/server/db/client";
import { AuthError, AuthPage, Unavailable } from "../auth-ui";
import { EnrolForm } from "./enrol-form";

export const metadata = {
  title: "Set up your account",
  // The link carries a one-time token: don't send it anywhere else.
  referrer: "no-referrer" as const,
};

export default function EnrolPage({ searchParams }: PageProps<"/admin/enrol">) {
  return (
    <AuthPage title="Set up your account">
      <Suspense fallback={null}>
        <Enrol searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function Enrol({
  searchParams,
}: {
  searchParams: PageProps<"/admin/enrol">["searchParams"];
}) {
  const { t } = await searchParams;
  await connection();
  if (!adminAvailable()) return <Unavailable />;
  const token = typeof t === "string" ? t : "";
  const enrolment = token
    ? await beginEnrolment(db(), token, credentialKeys())
    : null;
  if (!enrolment)
    return (
      <AuthError>
        This set-up link is invalid, already used or expired. Ask for a new one.
      </AuthError>
    );
  const grouped = enrolment.secret.match(/.{1,4}/g)!.join(" ");
  return (
    <div className="mt-6 space-y-6">
      <p>
        Signing in as <strong>{enrolment.email}</strong> will need your password
        and a code from an authenticator app (for example Google Authenticator,
        Microsoft Authenticator, 1Password or Bitwarden).
      </p>
      <section aria-labelledby="step-app" className="space-y-2">
        <h2 id="step-app" className="text-xl">
          1. Add this key to your authenticator app
        </h2>
        <p>Choose &ldquo;enter a setup key&rdquo; and type:</p>
        <p className="rounded-soft bg-mist p-3 font-mono text-lg tracking-wider break-all">
          {grouped}
        </p>
        <p className="text-sm text-ink-muted">
          Account: Lodge on the Lake. Type: time-based. Some password managers
          accept this link instead:{" "}
          <span className="font-mono break-all">
            {otpauthUri(enrolment.email, enrolment.secret)}
          </span>
        </p>
      </section>
      <EnrolForm token={token} />
    </div>
  );
}
