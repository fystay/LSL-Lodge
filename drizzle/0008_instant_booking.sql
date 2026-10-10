-- Instant booking with full payment and a 24-hour free-cancellation window.
-- Hand-edited after drizzle-kit generate. Nothing is dropped or deleted.

ALTER TABLE "payments" ADD COLUMN "provider_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "requested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing rows: the request time is when the row was created.
UPDATE "reservations" SET "requested_at" = "created_at";--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "free_cancellation_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "cancellation_policy" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "cancelled_by" text;--> statement-breakpoint

-- 1. The request time, cancellation deadline and policy snapshot are as
--    immutable as the agreed price (the clock never resets).
CREATE OR REPLACE FUNCTION "reservations_protect_quote_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quote_snapshot IS DISTINCT FROM OLD.quote_snapshot
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.free_cancellation_until IS DISTINCT FROM OLD.free_cancellation_until
     OR NEW.cancellation_policy IS DISTINCT FROM OLD.cancellation_policy THEN
    RAISE EXCEPTION 'reservation price, request time and cancellation terms are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "reservations_quote_immutable" ON "reservations";--> statement-breakpoint
CREATE TRIGGER "reservations_quote_immutable"
  BEFORE UPDATE OF "quote_snapshot", "total_minor", "currency", "requested_at", "free_cancellation_until", "cancellation_policy"
  ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_protect_quote_snapshot"();--> statement-breakpoint

-- 2. Website bookings start only as a payment hold: no more requests
--    awaiting approval. (Existing REQUESTED/APPROVED rows can still expire
--    or be cancelled; the state machine is unchanged.)
CREATE OR REPLACE FUNCTION "reservations_enforce_initial_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.source = 'DIRECT' AND NEW.status = 'PENDING_PAYMENT') OR
    (NEW.source = 'OWNER_MANUAL' AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE'))
  ) THEN
    RAISE EXCEPTION 'reservation cannot be created with status % from source %', NEW.status, NEW.source
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 3. Owner blocks and bookings may never overlap, whichever is written
--    second. The application already checks this under the property row
--    lock (which serialises both paths); these triggers are the database
--    backstop. A hold past its expiry no longer counts.
CREATE FUNCTION "reservations_refuse_owner_block_overlap"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialise with block writes on the same property (the application takes
  -- the same lock first), then check against committed blocks.
  PERFORM 1 FROM properties WHERE id = NEW.property_id FOR UPDATE;
  IF NEW.status IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_DUE', 'REQUIRES_REVIEW')
     AND EXISTS (
       SELECT 1 FROM owner_blocks b
       WHERE b.property_id = NEW.property_id
         AND b.removed_at IS NULL
         AND b.stay && daterange(NEW.check_in, NEW.check_out, '[)')
     ) THEN
    RAISE EXCEPTION 'dates are blocked by the owner'
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "reservations_owner_block_overlap"
  BEFORE INSERT ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_refuse_owner_block_overlap"();--> statement-breakpoint

CREATE FUNCTION "owner_blocks_refuse_booking_overlap"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM properties WHERE id = NEW.property_id FOR UPDATE;
  IF NEW.removed_at IS NULL AND EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.property_id = NEW.property_id
      AND r.stay && daterange(NEW.starts_on, NEW.ends_on, '[)')
      AND (
        r.status IN ('CONFIRMED', 'PAYMENT_DUE', 'REQUIRES_REVIEW')
        OR (r.status IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT') AND r.hold_expires_at > now())
      )
  ) THEN
    RAISE EXCEPTION 'dates overlap a booking or live hold'
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "owner_blocks_booking_overlap"
  BEFORE INSERT OR UPDATE OF "starts_on", "ends_on", "removed_at" ON "owner_blocks"
  FOR EACH ROW EXECUTE FUNCTION "owner_blocks_refuse_booking_overlap"();
