-- Host-approval workflow: a guest's request holds the dates until the owner
-- approves or declines; an approved request holds them until the guest pays.
--
-- Hand-edited after drizzle-kit generate. drizzle's migrator applies every
-- pending migration in ONE transaction, and PostgreSQL forbids using an enum
-- value added by ALTER TYPE ... ADD VALUE in the transaction that added it. The
-- new statuses are needed below (exclusion constraint, checks, triggers), so
-- reservation_status is replaced by a new type instead of extended.

CREATE TYPE "public"."booking_mode" AS ENUM('REQUEST', 'INSTANT');--> statement-breakpoint
-- Not used elsewhere in this migration, so ADD VALUE is safe here.
ALTER TYPE "public"."notification_status" ADD VALUE 'SUPPRESSED';--> statement-breakpoint

-- 1. Drop everything that depends on the old status type.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_no_overlapping_active_stays";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_hold_has_expiry";--> statement-breakpoint
DROP INDEX "reservations_hold_expiry_idx";--> statement-breakpoint
DROP TRIGGER "reservations_status_transition" ON "reservations";--> statement-breakpoint

-- 2. Swap the type.
ALTER TYPE "public"."reservation_status" RENAME TO "reservation_status_old";--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('REQUESTED', 'APPROVED', 'DECLINED', 'PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_DUE', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'REQUIRES_REVIEW');--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "status" TYPE "public"."reservation_status" USING "status"::text::"public"."reservation_status";--> statement-breakpoint
DROP TYPE "public"."reservation_status_old";--> statement-breakpoint

-- 3. New columns.
ALTER TABLE "payments" ADD COLUMN "checkout_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "booking_mode" "booking_mode" DEFAULT 'REQUEST' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "request_response_hours" smallint DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "payment_window_hours" smallint DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "declined_by" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "owner_note" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "review_reason" text;--> statement-breakpoint

-- 4. Checks and indexes.
CREATE INDEX "reservations_hold_expiry_idx" ON "reservations" USING btree ("hold_expires_at") WHERE "reservations"."status" IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT');--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_request_response_hours_range" CHECK ("properties"."request_response_hours" BETWEEN 1 AND 168);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_payment_window_hours_range" CHECK ("properties"."payment_window_hours" BETWEEN 1 AND 168);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_approved_has_approver" CHECK ("reservations"."status" <> 'APPROVED' OR "reservations"."approved_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_hold_has_expiry" CHECK ("reservations"."status" NOT IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT') OR "reservations"."hold_expires_at" IS NOT NULL);--> statement-breakpoint

-- 5. Overlap protection, now covering requests awaiting the owner and approved
--    requests awaiting payment. Must match BLOCKING_STATUSES in
--    src/server/booking/reservation-state.ts.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlapping_active_stays"
  EXCLUDE USING gist ("property_id" WITH =, "stay" WITH &&)
  WHERE ("status" IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_DUE', 'REQUIRES_REVIEW'));--> statement-breakpoint

-- 6. State machine. Must match ALLOWED_TRANSITIONS in
--    src/server/booking/reservation-state.ts (an integration test checks every pair).
CREATE OR REPLACE FUNCTION "reservations_enforce_status_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'REQUESTED'       AND NEW.status IN ('APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'APPROVED'        AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE', 'EXPIRED', 'CANCELLED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE', 'EXPIRED', 'CANCELLED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'CONFIRMED'       AND NEW.status IN ('CANCELLED', 'REFUND_PENDING', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'PAYMENT_DUE'     AND NEW.status IN ('CONFIRMED', 'CANCELLED', 'REFUND_PENDING', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'EXPIRED'         AND NEW.status IN ('REQUIRES_REVIEW')) OR
    (OLD.status = 'CANCELLED'       AND NEW.status IN ('REFUND_PENDING')) OR
    (OLD.status = 'REFUND_PENDING'  AND NEW.status IN ('REFUNDED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'REQUIRES_REVIEW' AND NEW.status IN ('APPROVED', 'DECLINED', 'CONFIRMED', 'PAYMENT_DUE', 'CANCELLED', 'REFUND_PENDING'))
  ) THEN
    RAISE EXCEPTION 'illegal reservation status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.lock_version := OLD.lock_version + 1;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "reservations_status_transition"
  BEFORE UPDATE OF "status" ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_enforce_status_transition"();--> statement-breakpoint

-- 7. Website reservations start as a request (host approval) or, for the
--    future instant mode, a payment hold. Never as confirmed.
CREATE OR REPLACE FUNCTION "reservations_enforce_initial_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.source = 'DIRECT' AND NEW.status IN ('REQUESTED', 'PENDING_PAYMENT')) OR
    (NEW.source = 'OWNER_MANUAL' AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE'))
  ) THEN
    RAISE EXCEPTION 'reservation cannot be created with status % from source %', NEW.status, NEW.source
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
