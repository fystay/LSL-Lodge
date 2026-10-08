-- Required for GiST indexes/exclusion constraints that combine uuid equality with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('SYSTEM', 'OWNER', 'GUEST', 'WEBHOOK', 'JOB');--> statement-breakpoint
CREATE TYPE "public"."busy_period_status" AS ENUM('ACTIVE', 'CANCELLED', 'REMOVED_FROM_SOURCE');--> statement-breakpoint
CREATE TYPE "public"."calendar_provider" AS ENUM('GOOGLE', 'AIRBNB_ICAL', 'OTHER_ICAL', 'CHANNEL_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."event_link_state" AS ENUM('PENDING_CREATE', 'PENDING_UPDATE', 'PENDING_DELETE', 'SYNCED', 'DELETED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."fee_kind" AS ENUM('PER_STAY', 'PER_NIGHT', 'PER_GUEST_PER_NIGHT', 'PERCENT_OF_ACCOMMODATION');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('CHARGE', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."payment_plan_mode" AS ENUM('FULL', 'DEPOSIT');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('FULL', 'DEPOSIT', 'BALANCE');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."recipient_kind" AS ENUM('GUEST', 'OWNER');--> statement-breakpoint
CREATE TYPE "public"."reservation_source" AS ENUM('DIRECT', 'OWNER_MANUAL');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_DUE', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'REQUIRES_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."schedule_item_status" AS ENUM('SCHEDULED', 'PAID', 'OVERDUE', 'CANCELLED', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."sync_direction" AS ENUM('IMPORT', 'EXPORT');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('NEVER_SYNCED', 'OK', 'STALE', 'ERROR', 'DISCONNECTED');--> statement-breakpoint
CREATE TYPE "public"."tax_treatment" AS ENUM('INCLUDED', 'EXCLUDED', 'NOT_APPLICABLE', 'UNCONFIRMED');--> statement-breakpoint
CREATE TYPE "public"."webhook_state" AS ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"reservation_id" uuid,
	"owner_block_id" uuid,
	"external_event_id" text,
	"state" "event_link_state" DEFAULT 'PENDING_CREATE' NOT NULL,
	"content_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_links_source_event" UNIQUE("source_id","external_event_id"),
	CONSTRAINT "calendar_event_links_source_reservation" UNIQUE("source_id","reservation_id"),
	CONSTRAINT "calendar_event_links_source_owner_block" UNIQUE("source_id","owner_block_id"),
	CONSTRAINT "calendar_event_links_one_target" CHECK (num_nonnulls("calendar_event_links"."reservation_id", "calendar_event_links"."owner_block_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "external_busy_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"external_uid" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "busy_period_status" DEFAULT 'ACTIVE' NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"stay" daterange GENERATED ALWAYS AS (daterange(starts_on, ends_on, '[)')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_busy_periods_source_uid" UNIQUE("source_id","external_uid"),
	CONSTRAINT "external_busy_periods_range_valid" CHECK ("external_busy_periods"."ends_on" > "external_busy_periods"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "external_calendar_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"direction" "sync_direction" NOT NULL,
	"label" text NOT NULL,
	"encrypted_config" text,
	"encryption_key_version" smallint,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_status" "sync_status" DEFAULT 'NEVER_SYNCED' NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"http_etag" text,
	"http_last_modified" text,
	"provider_sync_token" text,
	"stale_after_minutes" integer DEFAULT 60 NOT NULL,
	"next_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "fee_kind" NOT NULL,
	"amount_minor" integer,
	"basis_points" integer,
	"applies_above_guests" smallint,
	"mandatory" boolean DEFAULT true NOT NULL,
	"tax_treatment" "tax_treatment" DEFAULT 'UNCONFIRMED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_rules_amount_shape" CHECK (("fee_rules"."kind" = 'PERCENT_OF_ACCOMMODATION' AND "fee_rules"."basis_points" IS NOT NULL AND "fee_rules"."basis_points" >= 0 AND "fee_rules"."amount_minor" IS NULL)
        OR ("fee_rules"."kind" <> 'PERCENT_OF_ACCOMMODATION' AND "fee_rules"."amount_minor" IS NOT NULL AND "fee_rules"."amount_minor" >= 0 AND "fee_rules"."basis_points" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template" text NOT NULL,
	"recipient_kind" "recipient_kind" NOT NULL,
	"reservation_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_message_id" text,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "owner_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"stay" daterange GENERATED ALWAYS AS (daterange(starts_on, ends_on, '[)')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_blocks_range_valid" CHECK ("owner_blocks"."ends_on" > "owner_blocks"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "payment_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"mode" "payment_plan_mode" NOT NULL,
	"deposit_basis_points" integer,
	"deposit_fixed_minor" integer,
	"minimum_deposit_minor" integer,
	"balance_due_days_before_check_in" smallint,
	"full_payment_within_days" smallint,
	"cancellation_policy_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_policies_deposit_shape" CHECK ("payment_policies"."mode" = 'FULL'
        OR ("payment_policies"."balance_due_days_before_check_in" IS NOT NULL AND "payment_policies"."balance_due_days_before_check_in" >= 0
            AND (("payment_policies"."deposit_basis_points" IS NOT NULL AND "payment_policies"."deposit_basis_points" BETWEEN 1 AND 10000)
              OR ("payment_policies"."deposit_fixed_minor" IS NOT NULL AND "payment_policies"."deposit_fixed_minor" > 0))))
);
--> statement-breakpoint
CREATE TABLE "payment_schedule_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sequence" smallint NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"amount_minor" integer NOT NULL,
	"due_on" date NOT NULL,
	"paid_minor" integer DEFAULT 0 NOT NULL,
	"status" "schedule_item_status" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_schedule_items_reservation_sequence" UNIQUE("reservation_id","sequence"),
	CONSTRAINT "payment_schedule_items_amount_positive" CHECK ("payment_schedule_items"."amount_minor" > 0),
	CONSTRAINT "payment_schedule_items_paid_bounds" CHECK ("payment_schedule_items"."paid_minor" >= 0 AND "payment_schedule_items"."paid_minor" <= "payment_schedule_items"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"schedule_item_id" uuid,
	"kind" "payment_kind" NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"idempotency_key" text NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"stripe_refund_id" text,
	"failure_code" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "payments_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "payments_stripe_refund_id_unique" UNIQUE("stripe_refund_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"time_zone" text DEFAULT 'Europe/London' NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"max_guests" smallint NOT NULL,
	"default_min_nights" smallint DEFAULT 1 NOT NULL,
	"turnover_nights" smallint DEFAULT 0 NOT NULL,
	"check_in_time" text,
	"check_out_time" text,
	"booking_horizon_days" smallint DEFAULT 540 NOT NULL,
	"content_ref" text,
	"bookings_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_slug_unique" UNIQUE("slug"),
	CONSTRAINT "properties_max_guests_positive" CHECK ("properties"."max_guests" > 0),
	CONSTRAINT "properties_min_nights_positive" CHECK ("properties"."default_min_nights" > 0),
	CONSTRAINT "properties_turnover_non_negative" CHECK ("properties"."turnover_nights" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"nightly_minor" integer NOT NULL,
	"weekend_nightly_minor" integer,
	"min_nights" smallint,
	"allowed_arrival_weekdays" smallint[],
	"priority" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"stay" daterange GENERATED ALWAYS AS (daterange(starts_on, ends_on, '[)')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_rules_range_valid" CHECK ("rate_rules"."ends_on" > "rate_rules"."starts_on"),
	CONSTRAINT "rate_rules_nightly_non_negative" CHECK ("rate_rules"."nightly_minor" >= 0),
	CONSTRAINT "rate_rules_weekend_non_negative" CHECK ("rate_rules"."weekend_nightly_minor" IS NULL OR "rate_rules"."weekend_nightly_minor" >= 0),
	CONSTRAINT "rate_rules_min_nights_positive" CHECK ("rate_rules"."min_nights" IS NULL OR "rate_rules"."min_nights" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_ref" text NOT NULL,
	"property_id" uuid NOT NULL,
	"source" "reservation_source" DEFAULT 'DIRECT' NOT NULL,
	"status" "reservation_status" NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"guests" smallint NOT NULL,
	"guest_name" text NOT NULL,
	"guest_email" text NOT NULL,
	"guest_phone" text,
	"currency" char(3) NOT NULL,
	"total_minor" integer NOT NULL,
	"quote_snapshot" jsonb NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"stripe_customer_id" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"stay" daterange GENERATED ALWAYS AS (daterange(check_in, check_out, '[)')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_public_ref_unique" UNIQUE("public_ref"),
	CONSTRAINT "reservations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "reservations_range_valid" CHECK ("reservations"."check_out" > "reservations"."check_in"),
	CONSTRAINT "reservations_guests_positive" CHECK ("reservations"."guests" > 0),
	CONSTRAINT "reservations_total_non_negative" CHECK ("reservations"."total_minor" >= 0),
	CONSTRAINT "reservations_hold_has_expiry" CHECK ("reservations"."status" <> 'PENDING_PAYMENT' OR "reservations"."hold_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"state" "webhook_state" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "webhook_events_provider_event" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_source_id_external_calendar_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_calendar_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_owner_block_id_owner_blocks_id_fk" FOREIGN KEY ("owner_block_id") REFERENCES "public"."owner_blocks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_busy_periods" ADD CONSTRAINT "external_busy_periods_source_id_external_calendar_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_calendar_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_busy_periods" ADD CONSTRAINT "external_busy_periods_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendar_sources" ADD CONSTRAINT "external_calendar_sources_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_blocks" ADD CONSTRAINT "owner_blocks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_policies" ADD CONSTRAINT "payment_policies_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_schedule_item_id_payment_schedule_items_id_fk" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."payment_schedule_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_rules" ADD CONSTRAINT "rate_rules_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "external_busy_periods_property_stay_idx" ON "external_busy_periods" USING gist ("property_id","stay");--> statement-breakpoint
CREATE INDEX "external_calendar_sources_next_sync_idx" ON "external_calendar_sources" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "notification_jobs_due_idx" ON "notification_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "owner_blocks_property_stay_idx" ON "owner_blocks" USING gist ("property_id","stay");--> statement-breakpoint
CREATE INDEX "payment_schedule_items_due_idx" ON "payment_schedule_items" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "payments_reservation_idx" ON "payments" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "rate_rules_property_stay_idx" ON "rate_rules" USING gist ("property_id","stay");--> statement-breakpoint
CREATE INDEX "reservations_property_stay_idx" ON "reservations" USING gist ("property_id","stay");--> statement-breakpoint
CREATE INDEX "reservations_status_idx" ON "reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reservations_hold_expiry_idx" ON "reservations" USING btree ("hold_expires_at") WHERE "reservations"."status" = 'PENDING_PAYMENT';--> statement-breakpoint
CREATE INDEX "webhook_events_state_idx" ON "webhook_events" USING btree ("state");