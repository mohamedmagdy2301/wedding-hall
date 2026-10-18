CREATE TYPE "public"."payment_kind" AS ENUM('deposit', 'installment', 'payment', 'refund');--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installments_amount_check" CHECK ("installments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"received_by" uuid NOT NULL,
	"note" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_venue_receipt_no_unique" UNIQUE("venue_id","receipt_no"),
	CONSTRAINT "payments_receipt_no_check" CHECK ("payments"."receipt_no" ~ '^[0-9]{6,}$'),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_void_check" CHECK (num_nonnulls("payments"."voided_at", "payments"."voided_by", "payments"."void_reason") IN (0, 3)
        AND ("payments"."void_reason" IS NULL OR length("payments"."void_reason") BETWEEN 3 AND 300)),
	CONSTRAINT "payments_note_check" CHECK ("payments"."note" IS NULL OR length("payments"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "receipt_counters" (
	"venue_id" uuid PRIMARY KEY NOT NULL,
	"last_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_counters_last_no_check" CHECK ("receipt_counters"."last_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installments_booking_idx" ON "installments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "installments_due_date_idx" ON "installments" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx" ON "payments" USING btree ("paid_at");--> statement-breakpoint
-- D-125 (CLAUDE.md rule 4, BR-64): a payment is never deleted, and the only change ever made
-- to one is voiding it once — amount, kind, date and receipt number stay as recorded.
-- TRUNCATE is unaffected.
CREATE FUNCTION "payments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'payments are never deleted (D-125)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."voided_at" IS NOT NULL OR NEW."voided_at" IS NULL
		OR (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at')
			IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at') THEN
		RAISE EXCEPTION 'a payment only changes by being voided once (D-125)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payments_no_delete_or_edit" BEFORE UPDATE OR DELETE ON "payments"
	FOR EACH ROW EXECUTE FUNCTION "payments_guard"();
