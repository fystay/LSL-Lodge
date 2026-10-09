import { describe, expect, it } from "vitest";
import { signGuestLink, verifyGuestLink } from "./guest-link";

const SECRET = "test-secret-test-secret-test-secret-00";
const REF = "LL-ABC234";
const ID = "8f8d4a7e-2a5b-4c1d-9e3f-0a1b2c3d4e5f";
const NOW = Date.UTC(2026, 9, 9);

describe("guest links", () => {
  it("verifies for the booking it was issued for", () => {
    const token = signGuestLink(SECRET, REF, ID, NOW);
    expect(verifyGuestLink(SECRET, token, REF, ID, NOW)).toBe(true);
  });

  it("rejects another booking, another secret, tampering and expiry", () => {
    const token = signGuestLink(SECRET, REF, ID, NOW);
    expect(verifyGuestLink(SECRET, token, "LL-ZZZ999", ID, NOW)).toBe(false);
    expect(verifyGuestLink(SECRET, token, REF, ID.replace("8", "9"), NOW)).toBe(
      false,
    );
    expect(verifyGuestLink(`${SECRET}x`, token, REF, ID, NOW)).toBe(false);
    const [p, exp, sig] = token.split(".");
    expect(
      verifyGuestLink(SECRET, `${p}.${Number(exp) + 1}.${sig}`, REF, ID, NOW),
    ).toBe(false);
    expect(verifyGuestLink(SECRET, `${token}.x`, REF, ID, NOW)).toBe(false);
    expect(verifyGuestLink(SECRET, token, REF, ID, Number(exp) + 1)).toBe(
      false,
    );
  });
});
