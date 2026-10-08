import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed admin session tokens: `<base64url(payload)>.<base64url(hmac)>`.
 * HMAC-SHA256 from Node's crypto; payload carries only the email and expiry.
 */

export interface AdminSession {
  email: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export const SESSION_HOURS = 8;

export function signSession(session: AdminSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): AdminSession | null {
  if (!token) return null;
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof session?.email !== "string" || typeof session?.exp !== "number")
      return null;
    if (session.exp <= now) return null;
    return { email: session.email, exp: session.exp };
  } catch {
    return null;
  }
}

export function parseAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
