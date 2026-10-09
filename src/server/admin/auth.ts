import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { db, isDatabaseConfigured } from "@/server/db/client";
import { auditLogs } from "@/server/db/schema";
import { credentialKeys } from "@/server/crypto/keys";
import { authenticate, SESSION, type AdminIdentity } from "./accounts";

/**
 * Admin authentication and authorisation for pages and server actions.
 *
 * Every admin page calls requireAdmin("view") (through adminContext) and
 * every admin server action calls requireAdmin("manage") before doing
 * anything; nothing relies on layouts, hidden links or client checks.
 *
 * - Accounts, sessions and the second factor: src/server/admin/accounts.ts.
 * - Cookie: random token (hash stored server-side), httpOnly,
 *   SameSite=Strict, Secure and `__Host-` prefixed in production.
 * - CSRF: Next.js rejects a server action whose Origin differs from the
 *   host, but lets through a request with no Origin at all, so "manage"
 *   actions additionally require a matching Origin header.
 * - Roles: OWNER may do everything; VIEWER may only look.
 * - Sensitive actions ({ fresh: true }) need the second factor re-entered
 *   within the last SESSION.freshMinutes.
 *
 * The dashboard is available only where a database and the credential
 * encryption key are configured (TOTP secrets are stored encrypted).
 */

const secureCookies = process.env.NODE_ENV === "production";
export const ADMIN_COOKIE = secureCookies
  ? "__Host-lodge_admin"
  : "lodge_admin";
export const PENDING_COOKIE = secureCookies
  ? "__Host-lodge_admin_pending"
  : "lodge_admin_pending";

export type Permission = "view" | "manage";

const ROLE_PERMISSIONS: Record<AdminIdentity["role"], readonly Permission[]> = {
  OWNER: ["view", "manage"],
  VIEWER: ["view"],
};

export const canDo = (role: AdminIdentity["role"], permission: Permission) =>
  ROLE_PERMISSIONS[role].includes(permission);

/** True when admin sign-in can work on this deployment. */
export function adminAvailable(): boolean {
  if (!isDatabaseConfigured()) return false;
  try {
    credentialKeys();
    return true;
  } catch {
    return false;
  }
}

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: secureCookies,
  sameSite: "strict" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});

export async function setSessionCookie(
  name: string,
  token: string,
  maxAgeSeconds: number,
) {
  (await cookies()).set(name, token, cookieOptions(maxAgeSeconds));
}

export async function getAdmin(): Promise<AdminIdentity | null> {
  if (!adminAvailable()) return null;
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return authenticate(db(), token);
}

/**
 * Throws a redirect unless the request carries an Origin header for this
 * host. Server actions are always POSTs from our own pages, which browsers
 * always send with Origin.
 */
export async function assertSameOrigin(): Promise<void> {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  let ok = false;
  try {
    ok = Boolean(origin && host && new URL(origin).host === host);
  } catch {
    ok = false;
  }
  if (!ok) redirect("/admin/login?error=origin");
}

/**
 * The signed-in admin, or a redirect: to sign-in if there's no valid
 * session, to the overview if the role lacks the permission, or to
 * re-authentication if a fresh second factor is required.
 */
export async function requireAdmin(
  permission: Permission = "view",
  options: { fresh?: boolean; returnTo?: string } = {},
): Promise<AdminIdentity> {
  if (permission === "manage") await assertSameOrigin();
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");
  if (!canDo(admin.role, permission)) {
    await db().insert(auditLogs).values({
      actorType: "OWNER",
      actorId: admin.email,
      action: "admin.forbidden",
      targetType: "admin_user",
      targetId: admin.userId,
      metadata: { permission },
    });
    redirect("/admin?error=forbidden");
  }
  if (options.fresh && !isFresh(admin.reauthenticatedAt, new Date())) {
    const next =
      options.returnTo && /^\/admin(\/|$)/.test(options.returnTo)
        ? options.returnTo
        : "/admin";
    redirect(`/admin/reauth?next=${encodeURIComponent(next)}` as Route);
  }
  return admin;
}

export function isFresh(reauthenticatedAt: Date | null, now: Date): boolean {
  return (
    reauthenticatedAt !== null &&
    now.getTime() - reauthenticatedAt.getTime() <= SESSION.freshMinutes * 60_000
  );
}
