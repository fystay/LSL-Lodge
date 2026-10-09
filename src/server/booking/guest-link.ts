import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring guest links for emails ("view your booking", "pay now").
 *
 * The random access token from the booking form is stored only as a hash, so
 * it can't be put in an email sent later. Instead an email carries
 * `g1.<expiry>.<hmac>` over the booking reference and ID. The link's route
 * verifies it and moves it into the booking's httpOnly cookie, so it does not
 * linger in the address bar. Nothing about the guest is in the token.
 */

const PREFIX = "g1";
export const GUEST_LINK_DAYS = 90;

const mac = (
  secret: string,
  publicRef: string,
  reservationId: string,
  exp: number,
) =>
  createHmac("sha256", secret)
    .update(`guest-link|${publicRef}|${reservationId}|${exp}`)
    .digest("base64url");

export function signGuestLink(
  secret: string,
  publicRef: string,
  reservationId: string,
  now = Date.now(),
): string {
  const exp = now + GUEST_LINK_DAYS * 86_400_000;
  return `${PREFIX}.${exp}.${mac(secret, publicRef, reservationId, exp)}`;
}

export const looksLikeGuestLink = (token: string) =>
  token.startsWith(`${PREFIX}.`);

export function verifyGuestLink(
  secret: string,
  token: string,
  publicRef: string,
  reservationId: string,
  now = Date.now(),
): boolean {
  const [prefix, expText, given, extra] = token.split(".");
  if (prefix !== PREFIX || !expText || !given || extra !== undefined)
    return false;
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  const expected = Buffer.from(mac(secret, publicRef, reservationId, exp));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The signing secret, or null when guest links aren't configured (≥32 chars required). */
export function guestLinkSecret(): string | null {
  const secret = process.env.GUEST_LINK_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}
