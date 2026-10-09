import "server-only";
import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { Executor } from "@/server/db/client";
import { rateLimits } from "@/server/db/schema";

/**
 * Fixed-window rate limiting backed by Postgres, so it holds across
 * serverless instances without another service. One atomic upsert per check.
 *
 * Subjects (IP addresses, emails) are hashed before use: the table never
 * holds them in the clear, and rows are deleted once their window is old.
 */

export interface Limit {
  /** Short name of what is limited, e.g. "request:ip". */
  name: string;
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  requestPerIp: { name: "request:ip", max: 5, windowSeconds: 3600 },
  requestPerEmail: { name: "request:email", max: 3, windowSeconds: 86_400 },
  paymentPerBooking: { name: "payment:ref", max: 10, windowSeconds: 3600 },
  loginPerIp: { name: "login:ip", max: 10, windowSeconds: 900 },
  enquiryPerIp: { name: "enquiry:ip", max: 5, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

const hash = (value: string) =>
  createHash("sha256")
    .update(`rate-limit|${value}`)
    .digest("base64url")
    .slice(0, 32);

/**
 * Multiplies every limit. Default 1. Raised only for automated end-to-end
 * runs, where every test shares one address; it never disables limiting.
 */
function scale(): number {
  const n = Number(process.env.RATE_LIMIT_SCALE ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Counts one attempt; returns false if the subject is over the limit. */
export async function consumeRateLimit(
  db: Executor,
  limit: Limit,
  subject: string,
  now = new Date(),
): Promise<boolean> {
  const key = `${limit.name}:${hash(subject.trim().toLowerCase())}`;
  const windowStart = new Date(
    Math.floor(now.getTime() / (limit.windowSeconds * 1000)) *
      limit.windowSeconds *
      1000,
  );
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // SET expressions see the old row, so this compares the stored window.
        count: sql`CASE WHEN ${rateLimits.windowStart} = ${windowStart.toISOString()}::timestamptz THEN ${rateLimits.count} + 1 ELSE 1 END`,
        windowStart,
      },
    })
    .returning({ count: rateLimits.count });
  return row.count <= limit.max * scale();
}

/** Deletes counters from windows that ended more than a day ago. */
export async function pruneRateLimits(db: Executor, now = new Date()) {
  await db
    .delete(rateLimits)
    .where(
      lt(rateLimits.windowStart, new Date(now.getTime() - 2 * 86_400_000)),
    );
}

/**
 * The client's IP as seen by the hosting platform. Vercel overwrites
 * x-forwarded-for with the real client IP and drops client-supplied values
 * (vercel.com/docs/headers/request-headers), so it can't be spoofed there.
 * Behind another proxy, check that it does the same; with no header at all,
 * every client shares one bucket (fails safe, not open).
 */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
