import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  AIRBNB_FEED_POLICY,
  createSafeLookup,
  FeedFetchError,
  fetchFeed,
  isPublicAddress,
  validateFeedUrl,
} from "./safe-fetch";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FeedFetchError ? error.code : "unexpected";
  }
  return "no_error";
};

describe("validateFeedUrl", () => {
  it("accepts an Airbnb export URL", () => {
    const url = validateFeedUrl(
      "https://www.airbnb.co.uk/calendar/ical/123.ics?s=secret",
      AIRBNB_FEED_POLICY,
    );
    expect(url.hostname).toBe("www.airbnb.co.uk");
  });

  it("upgrades webcal:// to https", () => {
    expect(
      validateFeedUrl("webcal://calendar.example.com/feed.ics").protocol,
    ).toBe("https:");
  });

  it.each([
    ["http://www.airbnb.com/calendar/ical/1.ics", "https_required"],
    ["file:///etc/passwd", "https_required"],
    ["gopher://example.com/", "https_required"],
    ["https://user:pass@www.airbnb.com/x.ics", "credentials_in_url"],
    ["https://www.airbnb.com:8443/x.ics", "non_default_port"],
    ["https://127.0.0.1/x.ics", "ip_literal_not_allowed"],
    ["https://[::1]/x.ics", "ip_literal_not_allowed"],
    ["https://169.254.169.254/latest/meta-data", "ip_literal_not_allowed"],
    ["https://localhost/x.ics", "host_not_allowed"],
    ["https://printer.local/x.ics", "host_not_allowed"],
    ["not a url", "invalid_url"],
  ])("rejects %s", (raw, expected) => {
    expect(code(() => validateFeedUrl(raw))).toBe(expected);
  });

  it.each([
    "https://airbnb.com.evil.example/x.ics",
    "https://evilairbnb.com/x.ics",
    "https://example.com/x.ics",
  ])("enforces the Airbnb host allowlist for %s", (raw) => {
    expect(code(() => validateFeedUrl(raw, AIRBNB_FEED_POLICY))).toBe(
      "host_not_allowed",
    );
  });
});

describe("isPublicAddress", () => {
  it.each([
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "172.32.0.1",
    "2a00:1450:4009:81f::200e",
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("createSafeLookup", () => {
  const fakeResolver =
    (addresses: LookupAddress[]) =>
    (
      _host: string,
      _opts: { all: true },
      cb: (e: null, a: LookupAddress[]) => void,
    ) =>
      cb(null, addresses);

  const run = (addresses: LookupAddress[]) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>(
      (resolve) =>
        createSafeLookup(fakeResolver(addresses))(
          "feed.example.com",
          {},
          (error, address) => resolve({ error, address }),
        ),
    );

  it("passes public addresses through", async () => {
    const result = await run([{ address: "93.184.216.34", family: 4 }]);
    expect(result.error).toBeNull();
    expect(result.address).toBe("93.184.216.34");
  });

  it("refuses a hostname that resolves to a private address (DNS rebinding)", async () => {
    const result = await run([{ address: "10.0.0.5", family: 4 }]);
    expect(result.error?.code).toBe("ERR_PRIVATE_ADDRESS");
  });

  it("refuses when any one of several addresses is private", async () => {
    const result = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    expect(result.error?.code).toBe("ERR_PRIVATE_ADDRESS");
  });
});

describe("fetchFeed", () => {
  it("refuses unsafe URLs before any network access", async () => {
    await expect(
      fetchFeed("http://www.airbnb.com/x.ics"),
    ).rejects.toMatchObject({
      code: "https_required",
    });
  });

  it("never includes the feed URL in error messages", async () => {
    const secret =
      "https://user:topsecret@www.airbnb.com/calendar/ical/1.ics?s=abc";
    const error = await fetchFeed(secret).catch((e: Error) => e);
    expect(String(error)).not.toContain("topsecret");
    expect(String(error)).not.toContain("s=abc");
  });
});
