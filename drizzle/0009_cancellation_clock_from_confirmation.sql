-- The owner's cancellation window now starts when payment is verified and
-- the booking confirmed (confirmed_at), not when the booking was submitted.
-- Non-destructive: no column is dropped or rewritten. Existing rows keep the
-- deadline (and policy ID) they were booked under; requested_at stays as a
-- record of when the booking was submitted.

-- 1. For bookings under the new policy, the deadline must be exactly
--    confirmed_at + 24 hours (or not yet set, before confirmation).
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_confirmation_clock" CHECK ("reservations"."cancellation_policy" IS DISTINCT FROM 'FULL_REFUND_WITHIN_24H_OF_CONFIRMATION' OR "reservations"."free_cancellation_until" IS NULL OR ("reservations"."confirmed_at" IS NOT NULL AND "reservations"."free_cancellation_until" = "reservations"."confirmed_at" + interval '24 hours'));--> statement-breakpoint

-- 2. confirmed_at and free_cancellation_until are set once (from NULL) and
--    never changed or cleared afterwards, so duplicate, delayed or
--    out-of-order webhooks can't move the deadline. The price, request time
--    and policy stay fully immutable.
CREATE OR REPLACE FUNCTION "reservations_protect_quote_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quote_snapshot IS DISTINCT FROM OLD.quote_snapshot
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.cancellation_policy IS DISTINCT FROM OLD.cancellation_policy
     OR (OLD.free_cancellation_until IS NOT NULL
         AND NEW.free_cancellation_until IS DISTINCT FROM OLD.free_cancellation_until)
     OR (OLD.confirmed_at IS NOT NULL
         AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
    RAISE EXCEPTION 'reservation price, confirmation time and cancellation terms are immutable once set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "reservations_quote_immutable" ON "reservations";--> statement-breakpoint
CREATE TRIGGER "reservations_quote_immutable"
  BEFORE UPDATE OF "quote_snapshot", "total_minor", "currency", "requested_at", "free_cancellation_until", "cancellation_policy", "confirmed_at"
  ON "reservations"
  FOR EACH ROW EXECUTE FUNCTION "reservations_protect_quote_snapshot"();
