import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM, Node's built-in implementation) for
 * integration credentials stored in the database: OAuth refresh tokens and
 * private iCal feed URLs.
 *
 * Format: `v<keyVersion>.<iv>.<tag>.<ciphertext>` (base64url parts). The key
 * version lets keys rotate: decrypt with the version recorded, re-encrypt with
 * the current one. `context` is bound as additional authenticated data so a
 * ciphertext cannot be copied from one record to another.
 */

export interface CredentialKey {
  version: number;
  key: Buffer;
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super("Stored credential could not be decrypted");
    this.name = "CredentialDecryptionError";
  }
}

export function parseCredentialKey(
  base64Key: string,
  version: number,
): CredentialKey {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32)
    throw new Error("Credential key must be 32 bytes (base64)");
  if (!Number.isInteger(version) || version < 1)
    throw new Error("Invalid credential key version");
  return { version, key };
}

export function encryptCredential(
  plaintext: string,
  key: CredentialKey,
  context: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    `v${key.version}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function credentialKeyVersion(payload: string): number {
  const match = /^v(\d+)\./.exec(payload);
  if (!match) throw new CredentialDecryptionError();
  return Number(match[1]);
}

export function decryptCredential(
  payload: string,
  keys: readonly CredentialKey[],
  context: string,
): string {
  const parts = payload.split(".");
  if (parts.length !== 4) throw new CredentialDecryptionError();
  const key = keys.find((k) => `v${k.version}` === parts[0]);
  if (!key) throw new CredentialDecryptionError();
  try {
    const [, iv, tag, ciphertext] = parts.map((p) =>
      Buffer.from(p, "base64url"),
    );
    if (iv.length !== 12 || tag.length !== 16)
      throw new CredentialDecryptionError();
    const decipher = createDecipheriv("aes-256-gcm", key.key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CredentialDecryptionError();
  }
}
