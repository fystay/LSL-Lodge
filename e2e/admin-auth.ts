import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import postgres from "postgres";

/**
 * Test-only helpers that create admin accounts and sessions directly in the
 * LOCAL E2E database (global-setup refuses any other host), so most admin
 * tests don't depend on authenticator-code timing. The real sign-in journey
 * is covered separately in admin-security.spec.ts. These accounts have
 * unusable credentials: they can't sign in through the form.
 */

const sql = () =>
  postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

export const ADMIN_COOKIE =
  process.env.E2E_DEV_SERVER === "true" ? "lodge_admin" : "__Host-lodge_admin";

export async function mintAdminSession(
  context: BrowserContext,
  options: {
    email?: string;
    role?: "OWNER" | "VIEWER";
    /** Minutes since the second factor was last entered. */
    reauthMinutesAgo?: number;
    /** Minutes until the session's absolute expiry (negative = already expired). */
    expiresInMinutes?: number;
  } = {},
) {
  const email =
    options.email ?? `owner-${randomBytes(4).toString("hex")}@example.test`;
  const token = randomBytes(32).toString("base64url");
  const db = sql();
  try {
    const [user] = await db`
      INSERT INTO admin_users (email, role, password_hash, totp_secret_encrypted, enrolled_at)
      VALUES (${email}, ${options.role ?? "OWNER"}, 'unusable', 'unusable', now())
      ON CONFLICT (email) DO UPDATE SET role = excluded.role
      RETURNING id`;
    const reauth = options.reauthMinutesAgo ?? 0;
    await db`
      INSERT INTO admin_sessions
        (user_id, token_hash, mfa_verified_at, reauthenticated_at, last_seen_at, expires_at)
      VALUES (
        ${user.id},
        ${createHash("sha256").update(token).digest("hex")},
        now(),
        now() - ${`${reauth} minutes`}::interval,
        now(),
        now() + ${`${options.expiresInMinutes ?? 480} minutes`}::interval)`;
  } finally {
    await db.end();
  }
  await context.addCookies([
    {
      name: ADMIN_COOKIE,
      value: token,
      // Chrome treats localhost as a secure context, so the production
      // build's Secure, __Host- cookie works over http://localhost; DevTools
      // only accepts setting such a cookie against an https URL.
      url: `${ADMIN_COOKIE.startsWith("__Host-") ? "https" : "http"}://localhost:${process.env.E2E_PORT ?? 3100}`,
      httpOnly: true,
      secure: ADMIN_COOKIE.startsWith("__Host-"),
      sameSite: "Strict",
    },
  ]);
  return { email, token };
}
