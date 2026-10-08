import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorisedJobRequest } from "./auth";

const request = (authorization?: string) =>
  new Request("https://example.test/api/jobs/x", {
    headers: authorization ? { authorization } : {},
  });

describe("isAuthorisedJobRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the configured bearer secret", () => {
    vi.stubEnv("CRON_SECRET", "s".repeat(40));
    expect(isAuthorisedJobRequest(request(`Bearer ${"s".repeat(40)}`))).toBe(
      true,
    );
  });

  it("rejects missing or wrong credentials", () => {
    vi.stubEnv("CRON_SECRET", "s".repeat(40));
    expect(isAuthorisedJobRequest(request())).toBe(false);
    expect(isAuthorisedJobRequest(request("Bearer nope"))).toBe(false);
    expect(isAuthorisedJobRequest(request("s".repeat(40)))).toBe(false);
  });

  it("fails closed when no (or a weak) secret is configured", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorisedJobRequest(request("Bearer "))).toBe(false);
    vi.stubEnv("CRON_SECRET", "short");
    expect(isAuthorisedJobRequest(request("Bearer short"))).toBe(false);
  });
});
