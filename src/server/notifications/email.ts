import "server-only";

/**
 * Transactional email, behind a small interface so the provider can change.
 *
 * Delivery modes (EMAIL_DELIVERY):
 * - "off" (default): nothing is sent. Jobs are marked SUPPRESSED, and the
 *   owner can preview each message in /admin.
 * - "resend-sandbox": sent through Resend, but every recipient is replaced by
 *   Resend's test inbox (delivered@resend.dev). For checking the integration
 *   without emailing real people.
 * - "resend": real recipients. Refused unless EMAIL_LIVE_DELIVERY_APPROVED is
 *   exactly "true" (owner approval, verified sending domain with SPF, DKIM
 *   and DMARC).
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
  readonly mode: "resend-sandbox" | "resend";
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export class EmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Email delivery failed: ${code}`);
    this.name = "EmailDeliveryError";
  }
}

export const RESEND_SANDBOX_RECIPIENT = "delivered@resend.dev";

type Fetch = typeof fetch;

export class ResendSender implements EmailSender {
  constructor(
    readonly mode: "resend-sandbox" | "resend",
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const to = this.mode === "resend" ? message.to : RESEND_SANDBOX_RECIPIENT;
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          reply_to: message.replyTo,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EmailDeliveryError("NETWORK", true);
    }
    if (!response.ok) {
      // 429 and 5xx are worth retrying; other 4xx are configuration errors.
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmailDeliveryError(`HTTP_${response.status}`, retryable);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    if (!body.id) throw new EmailDeliveryError("NO_MESSAGE_ID", true);
    return { providerMessageId: body.id };
  }
}

/** The configured sender, or null when delivery is off (messages are suppressed). */
export function getEmailSender(): EmailSender | null {
  const mode = process.env.EMAIL_DELIVERY ?? "off";
  if (mode !== "resend" && mode !== "resend-sandbox") return null;
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!apiKey || !from) return null;
  if (mode === "resend" && process.env.EMAIL_LIVE_DELIVERY_APPROVED !== "true")
    return null;
  return new ResendSender(mode, apiKey, from);
}

export function ownerNotificationAddress(): string | null {
  return process.env.OWNER_NOTIFICATION_EMAIL || null;
}
