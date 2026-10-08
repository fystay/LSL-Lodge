import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  parseAdminEmails,
  SESSION_HOURS,
  signSession,
  verifySession,
} from "./session";

/**
 * Admin authentication.
 *
 * Every admin page and every admin server action calls `requireAdmin()`;
 * nothing relies on layouts or client checks.
 *
 * Modes (ADMIN_AUTH_MODE):
 * - "local": email allowlist + shared password, for local development and
 *   automated tests ONLY. Refused on any Vercel deployment (VERCEL is set) and
 *   whenever the secrets are missing or weak.
 * - "supabase": managed auth with MFA (planned; requires the owner's Supabase
 *   project). Until implemented it grants nobody access.
 * Anything else: admin is disabled.
 */

const COOKIE = "lodge_admin";

export type AdminAuthMode = "local" | "supabase" | "disabled";

export function adminAuthMode(): AdminAuthMode {
  const mode = process.env.ADMIN_AUTH_MODE;
  if (mode === "local") return localModeAllowed() ? "local" : "disabled";
  if (mode === "supabase") return "supabase";
  return "disabled";
}

function localModeAllowed(): boolean {
  if (process.env.VERCEL) return false;
  return (
    (process.env.ADMIN_LOCAL_PASSWORD ?? "").length >= 16 &&
    (process.env.ADMIN_SESSION_SECRET ?? "").length >= 32 &&
    parseAdminEmails(process.env.ADMIN_EMAILS).size > 0
  );
}

export interface Admin {
  email: string;
}

export async function getAdmin(): Promise<Admin | null> {
  if (adminAuthMode() !== "local") return null;
  const token = (await cookies()).get(COOKIE)?.value;
  const session = verifySession(token, process.env.ADMIN_SESSION_SECRET!);
  if (!session) return null;
  // Re-check the allowlist on every request, so removing an email revokes access.
  if (!parseAdminEmails(process.env.ADMIN_EMAILS).has(session.email))
    return null;
  return { email: session.email };
}

/** Returns the signed-in admin or redirects to the login page. */
export async function requireAdmin(): Promise<Admin> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");
  return admin;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Local mode only. Returns false for any failure without saying which part was wrong. */
export async function signInLocal(
  email: string,
  password: string,
): Promise<boolean> {
  if (adminAuthMode() !== "local") return false;
  const normalised = email.trim().toLowerCase();
  const passwordOk = timingSafeEqual(
    digest(password),
    digest(process.env.ADMIN_LOCAL_PASSWORD!),
  );
  const emailOk = parseAdminEmails(process.env.ADMIN_EMAILS).has(normalised);
  if (!passwordOk || !emailOk) return false;

  const exp = Date.now() + SESSION_HOURS * 3_600_000;
  (await cookies()).set(
    COOKIE,
    signSession({ email: normalised, exp }, process.env.ADMIN_SESSION_SECRET!),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_HOURS * 3600,
    },
  );
  return true;
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}
