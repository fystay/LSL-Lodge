import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkEnvironment, formatChecks } from "./preflight";

const secret = () => randomBytes(24).toString("hex");
const good = (): Record<string, string | undefined> => ({
  DATABASE_URL: `postgres://lodge_app.ref:${secret()}@pooler.example.test:6543/postgres`,
  DATABASE_SCHEMA: "lodge",
  SITE_URL: "https://lsllodge-git-claude-instant-booking-fystay1.vercel.app",
  BOOKING_PREVIEW: "true",
  PROPERTY_TIME_ZONE: "Europe/London",
  GUEST_LINK_SECRET: secret(),
  CALENDAR_EXPORT_SECRET: secret(),
  CRON_SECRET: secret(),
  HEALTHCHECK_SECRET: secret(),
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  STRIPE_SECRET_KEY: `sk_test_${secret()}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${secret()}`,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: `pk_test_${secret()}`,
  EMAIL_DELIVERY: "off",
});
const failing = (env: Record<string, string | undefined>) =>
  checkEnvironment(env)
    .filter((c) => c.status === "FAIL")
    .map((c) => c.label);

describe("staging preflight: environment", () => {
  it("passes a complete staging configuration", () => {
    expect(failing(good())).toEqual([]);
  });

  it("never prints a configured value", () => {
    const env = good();
    const out = formatChecks(checkEnvironment(env));
    for (const [k, v] of Object.entries(env))
      if (v && v.length >= 16 && k !== "SITE_URL")
        expect(out, k).not.toContain(v);
    // Not even the password inside the connection string.
    const password = new URL(env.DATABASE_URL!).password;
    expect(out).not.toContain(password);
  });

  it("refuses live keys, production and real-world switches", () => {
    expect(
      failing({ ...good(), STRIPE_SECRET_KEY: `sk_live_${secret()}` }),
    ).toContain("STRIPE_SECRET_KEY is a TEST key");
    expect(
      failing({ ...good(), SITE_URL: "https://lsllodge.vercel.app" }),
    ).toContain("SITE_URL is not the production site");
    expect(failing({ ...good(), VERCEL_ENV: "production" })).toContain(
      "not the production environment",
    );
    for (const k of [
      "STRIPE_LIVE_MODE_APPROVED",
      "EMAIL_LIVE_DELIVERY_APPROVED",
      "SITE_INDEXABLE",
    ])
      expect(failing({ ...good(), [k]: "true" })).toContain(
        `${k} is not true on staging`,
      );
    expect(failing({ ...good(), EMAIL_DELIVERY: "resend" })).toContain(
      "EMAIL_DELIVERY is off or resend-sandbox",
    );
  });

  it("names each missing or weak setting", () => {
    const env = good();
    delete env.STRIPE_WEBHOOK_SECRET;
    env.CRON_SECRET = "short";
    env.HEALTHCHECK_SECRET = env.GUEST_LINK_SECRET;
    env.CREDENTIALS_ENCRYPTION_KEY = "not-32-bytes";
    env.BOOKING_PREVIEW = "false";
    env.DATABASE_SCHEMA = "Lodge; drop";
    expect(failing(env).sort()).toEqual(
      [
        "BOOKING_PREVIEW is true",
        "CREDENTIALS_ENCRYPTION_KEY is 32 bytes (base64)",
        "CRON_SECRET is at least 32 characters",
        "DATABASE_SCHEMA is a plain identifier",
        "STRIPE_WEBHOOK_SECRET is set",
        "each secret has its own value",
      ].sort(),
    );
  });
});
