import "server-only";
import { siteUrl } from "@/lib/site";

/**
 * Where Stripe Checkout sends the guest back to. The booking's access cookie
 * lives on the host the guest booked on, so returning them to a different
 * address of the same deployment (e.g. SITE_URL is the branch alias but they
 * opened the deployment's own URL) showed "page not found" after paying.
 *
 * The request's host is used only when it is one of this deployment's own
 * addresses: SITE_URL's host, or Vercel's VERCEL_URL / VERCEL_BRANCH_URL.
 * Anything else (a spoofed Host header, localhost) falls back to SITE_URL.
 */
export function checkoutReturnBase(
  requestHost: string | null,
  env: Record<string, string | undefined> = process.env,
  site: string = siteUrl,
): string {
  const host = (requestHost ?? "").trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return site;
  const own = new Set(
    [safeHost(site), env.VERCEL_URL, env.VERCEL_BRANCH_URL]
      .filter((h): h is string => Boolean(h))
      .map((h) => h.toLowerCase()),
  );
  return own.has(host) ? `https://${host}` : site;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
