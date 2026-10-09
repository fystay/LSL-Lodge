CREATE TYPE "public"."admin_role" AS ENUM('OWNER', 'VIEWER');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"reauthenticated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "admin_role" NOT NULL,
	"password_hash" text,
	"totp_secret_encrypted" text,
	"totp_last_step" integer,
	"recovery_code_hashes" text[],
	"enrolment_token_hash" text,
	"enrolment_expires_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email"),
	CONSTRAINT "admin_users_enrolment_token_hash_unique" UNIQUE("enrolment_token_hash"),
	CONSTRAINT "admin_users_enrolled_has_credentials" CHECK ("admin_users"."enrolled_at" IS NULL OR ("admin_users"."password_hash" IS NOT NULL AND "admin_users"."totp_secret_encrypted" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "admin_sessions" USING btree ("user_id");