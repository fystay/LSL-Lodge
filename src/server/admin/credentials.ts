import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Credential primitives for admin accounts, built only on Node's crypto:
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1) with a random 16-byte salt, stored
 *   as `scrypt$N$r$p$salt$hash`. Parameters are stored, so they can be raised
 *   later without breaking existing hashes.
 * - Second factor: TOTP (RFC 6238; HMAC-SHA1, 30-second steps, 6 digits),
 *   the scheme every authenticator app supports. Tested against the RFC's
 *   own test vectors.
 * - Recovery codes and one-time tokens: random, stored as SHA-256 hashes.
 */

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 32 } as const;
const maxmem = (N: number, r: number) => 256 * N * r;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Why a new password is unacceptable, or null if it's fine. */
export function passwordProblem(
  password: string,
  email: string,
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return "That password is too long.";
  if (password.trim().toLowerCase() === email.trim().toLowerCase())
    return "Don’t use your email address as your password.";
  if (new Set(password).size < 5) return "Use a less repetitive password.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(password, salt, keylen, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const key = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A valid hash of a random password: used so unknown emails cost the same time. */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () =>
  (dummyHash ??= hashPassword(randomBytes(32).toString("base64url")));

// --- Base32 (RFC 4648), for authenticator-app secrets ---------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// --- TOTP (RFC 6238) ----------------------------------------------------------------

export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(
  secret: Buffer,
  step: number,
  digits = TOTP_DIGITS,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (now: Date) =>
  Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

/**
 * Checks a code against the current step ±1 (clock drift). Returns the
 * matched step, or null. A step at or before `lastStep` is refused, so a code
 * can't be used twice.
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(base32Secret);
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUri(email: string, base32Secret: string): string {
  const issuer = "Lodge on the Lake";
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

// --- Recovery codes and one-time tokens ---------------------------------------------

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const normaliseRecoveryCode = (code: string) =>
  code.toLowerCase().replace(/[^a-z0-9]/g, "");

export function generateRecoveryCodes(count = 10): {
  codes: string[];
  hashes: string[];
} {
  const codes = Array.from({ length: count }, () => {
    let raw = "";
    for (let i = 0; i < 10; i++)
      raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(normaliseRecoveryCode(c))) };
}

/** Index of the matching stored hash, or -1. */
export function matchRecoveryCode(
  code: string,
  hashes: readonly string[],
): number {
  const clean = normaliseRecoveryCode(code);
  if (clean.length !== 10) return -1;
  const hashed = Buffer.from(sha256(clean));
  return hashes.findIndex((h) => {
    const stored = Buffer.from(h);
    return stored.length === hashed.length && timingSafeEqual(stored, hashed);
  });
}

export const randomToken = () => randomBytes(32).toString("base64url");
