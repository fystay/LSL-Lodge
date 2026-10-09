import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs } from "./dispatch";
import {
  EmailDeliveryError,
  getEmailSender,
  RESEND_SANDBOX_RECIPIENT,
  ResendSender,
} from "./email";

afterEach(() => vi.unstubAllEnvs());

const message = {
  to: "guest@example.test",
  subject: "Hello",
  text: "Body",
  idempotencyKey: "notification:abc",
};

function fakeFetch(status: number, body: unknown = { id: "msg_1" }) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("ResendSender", () => {
  it("redirects every recipient to Resend's test inbox in sandbox mode", async () => {
    const fetchImpl = fakeFetch(200);
    const sender = new ResendSender(
      "resend-sandbox",
      "re_test_dummy",
      "Lodge <bookings@example.test>",
      fetchImpl,
    );
    expect(await sender.send(message)).toEqual({ providerMessageId: "msg_1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(init.body)).to).toEqual([
      RESEND_SANDBOX_RECIPIENT,
    ]);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "notification:abc",
    );
  });

  it("classifies failures as retryable or not", async () => {
    const send = (status: number) =>
      new ResendSender("resend", "k", "f", fakeFetch(status, {})).send(message);
    await expect(send(429)).rejects.toMatchObject({
      code: "HTTP_429",
      retryable: true,
    });
    await expect(send(503)).rejects.toMatchObject({ retryable: true });
    await expect(send(422)).rejects.toMatchObject({
      code: "HTTP_422",
      retryable: false,
    });
    const network = new ResendSender(
      "resend",
      "k",
      "f",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(network.send(message)).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
  });
});

describe("getEmailSender", () => {
  it("is off unless explicitly configured", () => {
    vi.stubEnv("EMAIL_DELIVERY", "");
    vi.stubEnv("EMAIL_PROVIDER_API_KEY", "re_test_dummy");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "bookings@example.test");
    expect(getEmailSender()).toBeNull();
    vi.stubEnv("EMAIL_DELIVERY", "resend-sandbox");
    expect(getEmailSender()?.mode).toBe("resend-sandbox");
  });

  it("refuses real recipients without explicit approval", () => {
    vi.stubEnv("EMAIL_DELIVERY", "resend");
    vi.stubEnv("EMAIL_PROVIDER_API_KEY", "re_test_dummy");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "bookings@example.test");
    vi.stubEnv("EMAIL_LIVE_DELIVERY_APPROVED", "");
    expect(getEmailSender()).toBeNull();
    vi.stubEnv("EMAIL_LIVE_DELIVERY_APPROVED", "true");
    expect(getEmailSender()?.mode).toBe("resend");
  });
});

describe("backoffMs", () => {
  it("grows exponentially with jitter and is capped at an hour", () => {
    expect(backoffMs(1, () => 0.5)).toBe(60_000);
    expect(backoffMs(3, () => 0.5)).toBe(240_000);
    expect(backoffMs(1, () => 0)).toBe(30_000);
    expect(backoffMs(20, () => 0.999)).toBeLessThanOrEqual(1.5 * 3_600_000);
  });
});
