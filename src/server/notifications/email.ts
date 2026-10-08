import "server-only";
import { emailEnv } from "@/server/env";

/**
 * Transactional email abstraction. The provider (Resend or Postmark,
 * to be chosen with the owner) is plugged in behind this interface in
 * Phase 3. Until then `getEmailSender()` returns null and callers must tell the
 * user that nothing was sent; nothing pretends to deliver mail.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Stable key so retries never send twice. */
  idempotencyKey: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export function getEmailSender(): EmailSender | null {
  const env = emailEnv();
  if (!env.EMAIL_PROVIDER_API_KEY || !env.EMAIL_FROM_ADDRESS) return null;
  // Provider adapter not implemented yet (Phase 3). Fail closed.
  return null;
}

export function ownerNotificationAddress(): string | null {
  return emailEnv().OWNER_NOTIFICATION_EMAIL ?? null;
}
