import { connection } from "next/server";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { AdminSection, smallButton } from "@/components/admin-ui";
import { requireAdmin } from "@/server/admin/auth";
import { db } from "@/server/db/client";
import { adminUsers } from "@/server/db/schema";
import { signOutEverywhereAction } from "../../auth-actions";

export const metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <>
      <h1 className="text-title">Your account</h1>
      <Suspense fallback={<p className="mt-6">Loading…</p>}>
        <Account />
      </Suspense>
    </>
  );
}

async function Account() {
  await connection();
  const admin = await requireAdmin("view");
  const [user] = await db()
    .select({
      lastLoginAt: adminUsers.lastLoginAt,
      recoveryCodeHashes: adminUsers.recoveryCodeHashes,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, admin.userId));
  const remaining = user.recoveryCodeHashes?.length ?? 0;
  return (
    <div className="mt-6 space-y-6">
      <AdminSection id="identity" title="Sign-in">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
          <dt className="font-semibold">Email</dt>
          <dd className="break-all">{admin.email}</dd>
          <dt className="font-semibold">Access</dt>
          <dd>
            {admin.role === "OWNER" ? "Owner (full access)" : "Read-only"}
          </dd>
          <dt className="font-semibold">Recovery codes left</dt>
          <dd
            className={remaining <= 2 ? "font-semibold text-danger" : undefined}
          >
            {remaining}
            {remaining <= 2 ? " (ask for a reset to get new ones)" : ""}
          </dd>
        </dl>
      </AdminSection>
      <AdminSection id="sessions" title="Signed-in devices">
        <p>
          Lost a device, or signed in somewhere you shouldn&rsquo;t have? Sign
          out of every device, including this one.
        </p>
        <form action={signOutEverywhereAction} className="mt-3">
          <button type="submit" className={smallButton}>
            Sign out everywhere
          </button>
        </form>
      </AdminSection>
    </div>
  );
}
