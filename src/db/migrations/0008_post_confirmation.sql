CREATE TYPE "public"."booking_change_kind" AS ENUM('postpone', 'items', 'guests', 'price_override', 'discount');--> statement-breakpoint
CREATE TYPE "public"."credit_resolution" AS ENUM('refund', 'services');--> statement-breakpoint
CREATE TYPE "public"."discount_source" AS ENUM('request', 'price_override');--> statement-breakpoint
CREATE TYPE "public"."discount_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "booking_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "booking_change_kind" NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"total_before" bigint NOT NULL,
	"total_after" bigint NOT NULL,
	"credit_resolution" "credit_resolution",
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_changes_totals_check" CHECK ("booking_changes"."total_before" >= 0 AND "booking_changes"."total_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discount_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"source" "discount_source" DEFAULT 'request' NOT NULL,
	"status" "discount_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_requests_amount_check" CHECK ("discount_requests"."amount" > 0),
	CONSTRAINT "discount_requests_reason_check" CHECK (length("discount_requests"."reason") BETWEEN 3 AND 300),
	CONSTRAINT "discount_requests_decision_check" CHECK (("discount_requests"."status" = 'pending') = ("discount_requests"."decided_by" IS NULL AND "discount_requests"."decided_at" IS NULL)
        AND ("discount_requests"."status" <> 'pending' OR "discount_requests"."decision_note" IS NULL)
        AND ("discount_requests"."decision_note" IS NULL OR length("discount_requests"."decision_note") <= 300))
);
--> statement-breakpoint
ALTER TABLE "booking_items" ADD COLUMN "change_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_items" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_items" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "booking_items" ADD COLUMN "voided_change_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_changes" ADD CONSTRAINT "booking_changes_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_changes" ADD CONSTRAINT "booking_changes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_changes" ADD CONSTRAINT "booking_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_changes_booking_idx" ON "booking_changes" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "discount_requests_booking_idx" ON "discount_requests" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "discount_requests_venue_status_idx" ON "discount_requests" USING btree ("venue_id","status");--> statement-breakpoint
-- Deferred (hand-edited, D-130): a change's lines are written before its row, which records
-- the booking after them.
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_change_id_booking_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."booking_changes"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_voided_change_id_booking_changes_id_fk" FOREIGN KEY ("voided_change_id") REFERENCES "public"."booking_changes"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_void_check" CHECK (num_nonnulls("booking_items"."voided_at", "booking_items"."voided_by", "booking_items"."voided_change_id") IN (0, 3));--> statement-breakpoint
-- D-129 (CLAUDE.md rule 4): a discount request is never deleted, and changes once — from
-- pending to approved, rejected or withdrawn — keeping its amount, reason and requester.
CREATE FUNCTION "discount_requests_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'discount requests are never deleted (D-129)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."status" <> 'pending' OR NEW."status" = 'pending'
		OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'updated_at')
			IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'updated_at') THEN
		RAISE EXCEPTION 'a discount request only changes by being decided once (D-129)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "discount_requests_no_delete_or_edit" BEFORE UPDATE OR DELETE ON "discount_requests"
	FOR EACH ROW EXECUTE FUNCTION "discount_requests_guard"();
--> statement-breakpoint
-- D-130 (BR-42): the history of a confirmed booking's total is append-only.
CREATE FUNCTION "booking_changes_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'booking changes are never edited or deleted (D-130)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "booking_changes_append_only" BEFORE UPDATE OR DELETE ON "booking_changes"
	FOR EACH ROW EXECUTE FUNCTION "booking_changes_guard"();
--> statement-breakpoint
-- D-128: a voided line of a confirmed booking stays voided.
CREATE FUNCTION "booking_items_void_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."voided_at" IS NOT NULL THEN
		RAISE EXCEPTION 'a voided booking line never changes (D-128)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "booking_items_voided_frozen" BEFORE UPDATE ON "booking_items"
	FOR EACH ROW EXECUTE FUNCTION "booking_items_void_guard"();
