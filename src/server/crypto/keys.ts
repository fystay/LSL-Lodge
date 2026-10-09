import "server-only";
import { encryptionEnv } from "@/server/env";
import { parseCredentialKey, type CredentialKey } from "./credentials";

/** The configured credential-encryption key(s). Throws ConfigurationError if unset. */
export function credentialKeys(): CredentialKey[] {
  const env = encryptionEnv();
  return [
    parseCredentialKey(
      env.CREDENTIALS_ENCRYPTION_KEY,
      env.CREDENTIALS_ENCRYPTION_KEY_VERSION,
    ),
  ];
}
