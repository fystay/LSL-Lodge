import "server-only";
import { z } from "zod";

/**
 * Server-side environment access. Values are validated lazily, per feature, so
 * that the public site can build and run before every integration is
 * configured. A feature that needs a missing value fails closed with a clear
 * error rather than limping along.
 */

const optional = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const databaseSchema = z.object({
  DATABASE_URL: z.string().url(),
});

const encryptionSchema = z.object({
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "must be a base64-encoded 32-byte key",
    ),
  CREDENTIALS_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive(),
});

const stripeSchema = z.object({
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
});

const emailSchema = z.object({
  EMAIL_PROVIDER_API_KEY: optional,
  EMAIL_FROM_ADDRESS: optional,
  OWNER_NOTIFICATION_EMAIL: optional,
});

export class ConfigurationError extends Error {
  constructor(feature: string, issues: string[]) {
    // Only variable names are reported, never values.
    super(`${feature} is not configured: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

function parse<T extends z.ZodTypeAny>(feature: string, schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigurationError(
      feature,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")} ${issue.message}`,
      ),
    );
  }
  return result.data;
}

export const databaseEnv = () => parse("Database", databaseSchema);
export const encryptionEnv = () => parse("Encryption", encryptionSchema);
export const stripeEnv = () => parse("Stripe", stripeSchema);
export const emailEnv = () => parse("Email", emailSchema);

/** Stripe live keys are refused unless live payments were explicitly enabled. */
export function assertStripeTestModeUnlessApproved(secretKey: string) {
  if (
    secretKey.startsWith("sk_live_") &&
    process.env.STRIPE_LIVE_MODE_APPROVED !== "true"
  ) {
    throw new ConfigurationError("Stripe", [
      "live key supplied but STRIPE_LIVE_MODE_APPROVED is not 'true'",
    ]);
  }
}
