import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashPassword,
  matchRecoveryCode,
  otpauthUri,
  passwordProblem,
  totpAt,
  totpStep,
  verifyPassword,
  verifyTotp,
} from "./credentials";

describe("passwords", () => {
  it("verifies the right password and nothing else", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
      true,
    );
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(
      false,
    );
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    // Salted: the same password hashes differently each time.
    expect(await hashPassword("correct horse battery staple")).not.toBe(hash);
  });

  it("rejects weak new passwords", () => {
    expect(passwordProblem("short", "a@example.test")).toMatch(/at least 12/);
    expect(passwordProblem("owner@example.test", "owner@example.test")).toMatch(
      /email/,
    );
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "a@example.test")).toMatch(
      /repetitive/,
    );
    expect(
      passwordProblem("a perfectly fine passphrase", "a@example.test"),
    ).toBeNull();
  });
});

describe("TOTP (RFC 6238 test vectors, SHA-1)", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  it.each([
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ])("time %i gives %s", (seconds, expected) => {
    expect(totpAt(secret, Math.floor(seconds / 30), 8)).toBe(expected);
  });

  it("accepts the current code with ±1 step drift and refuses replays", () => {
    const b32 = base32Encode(secret);
    const now = new Date(1_234_567_890 * 1000);
    const step = totpStep(now);
    const code = totpAt(secret, step);
    expect(verifyTotp(b32, code, now, null)).toBe(step);
    expect(verifyTotp(b32, code, new Date(now.getTime() + 30_000), null)).toBe(
      step,
    );
    expect(
      verifyTotp(b32, code, new Date(now.getTime() + 90_000), null),
    ).toBeNull();
    // Already used: refused.
    expect(verifyTotp(b32, code, now, step)).toBeNull();
    expect(verifyTotp(b32, "12345", now, null)).toBeNull();
    expect(verifyTotp(b32, "abcdef", now, null)).toBeNull();
  });

  it("builds an otpauth URI authenticator apps understand", () => {
    const uri = otpauthUri("owner@example.test", "JBSWY3DPEHPK3PXP");
    expect(uri).toMatch(
      /^otpauth:\/\/totp\/Lodge%20on%20the%20Lake%3Aowner%40example\.test\?/,
    );
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("period=30");
  });
});

describe("base32 (RFC 4648 vectors)", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("%s ↔ %s", (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });
});

describe("recovery codes", () => {
  it("match once each, ignoring case and separators", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(
      matchRecoveryCode(codes[3].toUpperCase().replace("-", " "), hashes),
    ).toBe(3);
    expect(matchRecoveryCode("aaaaa-bbbbb", hashes)).toBe(-1);
    expect(hashes.join()).not.toContain(codes[0].replace("-", ""));
  });
});
