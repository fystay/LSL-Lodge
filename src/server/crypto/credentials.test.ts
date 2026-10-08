import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialDecryptionError,
  credentialKeyVersion,
  decryptCredential,
  encryptCredential,
  parseCredentialKey,
} from "./credentials";

const key1 = parseCredentialKey(randomBytes(32).toString("base64"), 1);
const key2 = parseCredentialKey(randomBytes(32).toString("base64"), 2);
const secret = "https://www.airbnb.co.uk/calendar/ical/123.ics?s=private-token";

describe("credential encryption", () => {
  it("round-trips", () => {
    const sealed = encryptCredential(secret, key1, "source:abc");
    expect(sealed).not.toContain("private-token");
    expect(decryptCredential(sealed, [key1], "source:abc")).toBe(secret);
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encryptCredential(secret, key1, "c")).not.toBe(
      encryptCredential(secret, key1, "c"),
    );
  });

  it("rejects tampered ciphertext", () => {
    const sealed = encryptCredential(secret, key1, "c");
    const parts = sealed.split(".");
    const bytes = Buffer.from(parts[3], "base64url");
    bytes[0] ^= 1;
    parts[3] = bytes.toString("base64url");
    expect(() => decryptCredential(parts.join("."), [key1], "c")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("binds ciphertext to its record context", () => {
    const sealed = encryptCredential(secret, key1, "source:abc");
    expect(() => decryptCredential(sealed, [key1], "source:other")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("supports key rotation by version", () => {
    const old = encryptCredential(secret, key1, "c");
    expect(credentialKeyVersion(old)).toBe(1);
    expect(decryptCredential(old, [key2, key1], "c")).toBe(secret);
    expect(() => decryptCredential(old, [key2], "c")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("rejects keys of the wrong length", () => {
    expect(() =>
      parseCredentialKey(randomBytes(16).toString("base64"), 1),
    ).toThrow();
  });
});
