import { describe, expect, it } from "vitest";
import { parseAdminEmails, signSession, verifySession } from "./session";

const secret = "x".repeat(40);
const now = 1_800_000_000_000;

describe("admin session tokens", () => {
  it("round-trips a valid session", () => {
    const token = signSession(
      { email: "owner@example.test", exp: now + 1000 },
      secret,
    );
    expect(verifySession(token, secret, now)).toEqual({
      email: "owner@example.test",
      exp: now + 1000,
    });
  });

  it("rejects expired, tampered, foreign-secret and malformed tokens", () => {
    const token = signSession(
      { email: "owner@example.test", exp: now + 1000 },
      secret,
    );
    expect(verifySession(token, secret, now + 1000)).toBeNull();

    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ email: "attacker@example.test", exp: now + 1000 }),
    ).toString("base64url");
    expect(verifySession(`${forged}.${mac}`, secret, now)).toBeNull();
    expect(verifySession(`${payload}.${mac}`, "y".repeat(40), now)).toBeNull();
    for (const bad of [
      undefined,
      "",
      "abc",
      `${payload}.${mac}.x`,
      `${payload}.`,
    ]) {
      expect(verifySession(bad, secret, now)).toBeNull();
    }
  });
});

describe("parseAdminEmails", () => {
  it("normalises a comma-separated allowlist", () => {
    expect(
      parseAdminEmails(" Owner@Example.test, ,second@example.test"),
    ).toEqual(new Set(["owner@example.test", "second@example.test"]));
    expect(parseAdminEmails(undefined).size).toBe(0);
  });
});
