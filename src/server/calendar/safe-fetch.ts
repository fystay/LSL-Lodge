import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbound fetching of owner-configured calendar feed URLs, hardened against
 * server-side request forgery (SSRF):
 *
 * - https only, default port only, no embedded credentials;
 * - optional hostname allowlist (used for Airbnb feeds);
 * - every resolved address must be public; the check happens inside the
 *   socket's DNS lookup, so the address validated is the address connected to
 *   (no DNS-rebinding window);
 * - redirects are followed manually (max 3) and each hop is re-validated;
 * - strict timeout and response-size cap.
 *
 * Errors carry a code only. Feed URLs are secrets (they grant read access to
 * the owner's calendar) and must never appear in errors or logs.
 */

export class FeedFetchError extends Error {
  constructor(readonly code: string) {
    super(`Calendar feed request failed (${code})`);
    this.name = "FeedFetchError";
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped addresses (::ffff:a.b.c.d) are unwrapped and checked as IPv4
  // in isPublicAddress. (A ::ffff:0:0/96 rule here would also match every
  // plain IPv4 address, because BlockList treats the two as equivalent.)
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export interface FeedUrlPolicy {
  /** If set, the hostname must equal or be a subdomain of one of these. */
  allowedHostSuffixes?: readonly string[];
}

export const AIRBNB_FEED_POLICY: FeedUrlPolicy = {
  allowedHostSuffixes: ["airbnb.com", "airbnb.co.uk"],
};

/** Validates a feed URL's shape. Throws FeedFetchError; returns the parsed URL. */
export function validateFeedUrl(raw: string, policy: FeedUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FeedFetchError("invalid_url");
  }
  // webcal:// is a common alias for an https iCal subscription.
  if (url.protocol === "webcal:")
    url = new URL(`https:${url.href.slice("webcal:".length)}`);
  if (url.protocol !== "https:") throw new FeedFetchError("https_required");
  if (url.username || url.password)
    throw new FeedFetchError("credentials_in_url");
  if (url.port && url.port !== "443")
    throw new FeedFetchError("non_default_port");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bareHost = host.replace(/^\[|\]$/g, "");
  if (isIP(bareHost)) throw new FeedFetchError("ip_literal_not_allowed");
  if (
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new FeedFetchError("host_not_allowed");
  }
  if (
    policy.allowedHostSuffixes &&
    !policy.allowedHostSuffixes.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    throw new FeedFetchError("host_not_allowed");
  }
  return url;
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

/**
 * A `lookup` for sockets that refuses to connect anywhere non-public. Exported
 * for tests; `resolver` defaults to the system resolver.
 */
export function createSafeLookup(
  resolver: LookupFn = dnsLookup as unknown as LookupFn,
) {
  return (
    hostname: string,
    options: { all?: boolean } | number,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    resolver(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      if (
        addresses.length === 0 ||
        !addresses.every((a) => isPublicAddress(a.address))
      ) {
        const error: NodeJS.ErrnoException = new FeedFetchError(
          "resolved_to_private_address",
        );
        error.code = "ERR_PRIVATE_ADDRESS";
        return callback(error, "");
      }
      const wantsAll = typeof options === "object" && options.all;
      if (wantsAll) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface ConditionalState {
  etag?: string | null;
  lastModified?: string | null;
}

export type FeedFetchResult =
  | { kind: "not_modified" }
  | { kind: "ok"; body: string; etag?: string; lastModified?: string };

export interface FetchFeedOptions {
  policy?: FeedUrlPolicy;
  conditional?: ConditionalState;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export async function fetchFeed(
  rawUrl: string,
  options: FetchFeedOptions = {},
): Promise<FeedFetchResult> {
  const {
    policy = {},
    conditional = {},
    timeoutMs = 10_000,
    maxBytes = 2_000_000,
  } = options;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;
  let url = validateFeedUrl(rawUrl, policy);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await requestOnce(url, conditional, deadline, maxBytes);
    if (response.kind === "redirect") {
      if (hop === maxRedirects) throw new FeedFetchError("too_many_redirects");
      let next: string;
      try {
        next = new URL(response.location, url).href;
      } catch {
        throw new FeedFetchError("invalid_redirect");
      }
      url = validateFeedUrl(next, policy);
      continue;
    }
    return response;
  }
  throw new FeedFetchError("too_many_redirects");
}

function requestOnce(
  url: URL,
  conditional: ConditionalState,
  deadline: number,
  maxBytes: number,
): Promise<FeedFetchResult | { kind: "redirect"; location: string }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FeedFetchError("timeout"));

    const headers: Record<string, string> = {
      Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1",
      "User-Agent": "LodgeOnTheLake-CalendarSync/1.0",
    };
    if (conditional.etag) headers["If-None-Match"] = conditional.etag;
    if (conditional.lastModified)
      headers["If-Modified-Since"] = conditional.lastModified;

    const req = request(
      url,
      {
        method: "GET",
        headers,
        lookup: createSafeLookup(),
        agent: false,
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume();
          const location = res.headers.location;
          if (!location)
            return reject(new FeedFetchError("redirect_without_location"));
          return resolve({ kind: "redirect", location });
        }
        if (status === 304) {
          res.resume();
          return resolve({ kind: "not_modified" });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new FeedFetchError(`http_${status}`));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new FeedFetchError("response_too_large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new FeedFetchError("response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            kind: "ok",
            body: Buffer.concat(chunks).toString("utf8"),
            etag: headerString(res.headers.etag),
            lastModified: headerString(res.headers["last-modified"]),
          }),
        );
        res.on("error", () => reject(new FeedFetchError("response_error")));
      },
    );
    req.on("timeout", () => req.destroy(new FeedFetchError("timeout")));
    req.on("error", (error) =>
      reject(
        error instanceof FeedFetchError
          ? error
          : new FeedFetchError(networkCode(error)),
      ),
    );
    req.end();
  });
}

function headerString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function networkCode(error: NodeJS.ErrnoException): string {
  if (error.code === "ERR_PRIVATE_ADDRESS")
    return "resolved_to_private_address";
  if (error.code === "ENOTFOUND") return "dns_not_found";
  if (error.code === "ECONNREFUSED") return "connection_refused";
  if (error.code === "ECONNRESET") return "connection_reset";
  if (error.code?.startsWith("ERR_TLS") || error.code?.includes("CERT"))
    return "tls_error";
  return "network_error";
}
