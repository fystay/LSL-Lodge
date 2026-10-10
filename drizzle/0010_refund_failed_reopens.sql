-- A refund Stripe had confirmed can later be reported failed (refund.failed,
-- e.g. the card was closed). The guest is then owed the money again, so a
-- REFUNDED booking may move back to REFUND_PENDING. Nothing else changes.
-- Non-destructive: replaces the transition function only. Must match
-- ALLOWED_TRANSITIONS in src/server/booking/reservation-state.ts (an
-- integration test checks every pair).
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
    (OLD.status = 'REFUNDED'        AND NEW.status IN ('REFUND_PENDING')) OR
    (OLD.status = 'REQUIRES_REVIEW' AND NEW.status IN ('APPROVED', 'DECLINED', 'CONFIRMED', 'PAYMENT_DUE', 'CANCELLED', 'REFUND_PENDING'))
  ) THEN
    RAISE EXCEPTION 'illegal reservation status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.lock_version := OLD.lock_version + 1;
  RETURN NEW;
END;
$$;
