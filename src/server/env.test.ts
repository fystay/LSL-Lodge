import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError, encryptionEnv } from "./env";

describe("encryptionEnv", () => {
  afterEach(() => vi.unstubAllEnvs());
  const key = randomBytes(32).toString("base64");

  it("treats an unset key version as 1", () => {
    // Staging once had the key without a version, which silently turned
    // admin sign-in off.
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", key);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_VERSION", undefined);
    expect(encryptionEnv().CREDENTIALS_ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it("keeps an explicit version", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", key);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_VERSION", "3");
    expect(encryptionEnv().CREDENTIALS_ENCRYPTION_KEY_VERSION).toBe(3);
  });

  it("still refuses a bad version or key, naming only the variable", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", key);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_VERSION", "0");
    expect(() => encryptionEnv()).toThrow(ConfigurationError);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY_VERSION", "1");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "c2hvcnQ=");
    expect(() => encryptionEnv()).toThrow(/CREDENTIALS_ENCRYPTION_KEY /);
    expect(() => encryptionEnv()).not.toThrow(/c2hvcnQ/);
  });
});
