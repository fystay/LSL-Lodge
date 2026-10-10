-- Sign-in recovery: a completed-sign-in marker on sessions (to tell a
-- duplicate submission from an expired one) and single-use password reset
-- tokens (hash and expiry only). Nothing is dropped or deleted.

ALTER TABLE "admin_sessions" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_reset_token_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_reset_expires_at" timestamp with time zone;