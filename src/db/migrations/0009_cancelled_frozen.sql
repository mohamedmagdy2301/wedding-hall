-- Q8-03, P8-08: a cancelled booking is frozen — no payment is recorded or voided on it any
-- more. The cancellation's own refund is written before the booking's status changes, in the
-- same transaction (BR-74), so it passes. The services refuse first; this is the backstop.
CREATE FUNCTION "payments_cancelled_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "bookings" WHERE "id" = NEW."booking_id" AND "status" = 'cancelled') THEN
		RAISE EXCEPTION 'a cancelled booking takes no payment changes (Q8-03)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payments_cancelled_frozen" BEFORE INSERT OR UPDATE ON "payments"
	FOR EACH ROW EXECUTE FUNCTION "payments_cancelled_guard"();
