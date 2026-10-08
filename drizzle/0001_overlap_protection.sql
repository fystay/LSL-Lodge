-- Database-level booking integrity. Hand-written: drizzle-kit cannot express
-- exclusion constraints or triggers.

-- 1. No two calendar-blocking reservations for the same property may overlap.
--    `stay` is daterange(check_in, check_out, '[)'), so a check-out and a
--    check-in on the same date do not conflict. Must match BLOCKING_STATUSES in
--    src/server/booking/reservation-state.ts.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlapping_active_stays"
  EXCLUDE USING gist ("property_id" WITH =, "stay" WITH &&)
  WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_DUE', 'REQUIRES_REVIEW'));
--> statement-breakpoint

-- 2. Status changes must follow the documented state machine. Must match
--    ALLOWED_TRANSITIONS in src/server/booking/reservation-state.ts.
CREATE FUNCTION "reservations_enforce_status_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE', 'EXPIRED', 'CANCELLED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'CONFIRMED'       AND NEW.status IN ('CANCELLED', 'REFUND_PENDING', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'PAYMENT_DUE'     AND NEW.status IN ('CONFIRMED', 'CANCELLED', 'REFUND_PENDING', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'EXPIRED'         AND NEW.status IN ('REQUIRES_REVIEW')) OR
    (OLD.status = 'CANCELLED'       AND NEW.status IN ('REFUND_PENDING')) OR
    (OLD.status = 'REFUND_PENDING'  AND NEW.status IN ('REFUNDED', 'REQUIRES_REVIEW')) OR
    (OLD.status = 'REQUIRES_REVIEW' AND NEW.status IN ('CONFIRMED', 'PAYMENT_DUE', 'CANCELLED', 'REFUND_PENDING'))
  ) THEN
    RAISE EXCEPTION 'illegal reservation status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.lock_version := OLD.lock_version + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "reservations_status_transition"
  BEFORE UPDATE OF "status" ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_enforce_status_transition"();
--> statement-breakpoint

-- 3. Direct (website) reservations can only be created as a payment hold; they
--    reach CONFIRMED only through a verified transition. Owner-entered
--    reservations may start as CONFIRMED or PAYMENT_DUE.
CREATE FUNCTION "reservations_enforce_initial_status"() RETURNS trigger
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
$$;
--> statement-breakpoint

CREATE TRIGGER "reservations_initial_status"
  BEFORE INSERT ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_enforce_initial_status"();
--> statement-breakpoint

-- 4. Quote snapshots are immutable once written.
CREATE FUNCTION "reservations_protect_quote_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quote_snapshot IS DISTINCT FROM OLD.quote_snapshot
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'reservation quote snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "reservations_quote_immutable"
  BEFORE UPDATE OF "quote_snapshot", "total_minor", "currency" ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_protect_quote_snapshot"();
