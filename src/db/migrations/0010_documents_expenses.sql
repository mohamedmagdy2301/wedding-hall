CREATE TYPE "public"."document_kind" AS ENUM('national_id', 'signed_contract', 'other');--> statement-breakpoint
CREATE TABLE "booking_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"file_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"remove_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_documents_file_key_unique" UNIQUE("file_key"),
	CONSTRAINT "booking_documents_mime_check" CHECK ("booking_documents"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CONSTRAINT "booking_documents_size_check" CHECK ("booking_documents"."size_bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "booking_documents_remove_check" CHECK (num_nonnulls("booking_documents"."removed_at", "booking_documents"."removed_by", "booking_documents"."remove_reason") IN (0, 3)
        AND ("booking_documents"."remove_reason" IS NULL OR length("booking_documents"."remove_reason") BETWEEN 3 AND 300))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"booking_id" uuid,
	"amount" bigint NOT NULL,
	"spent_on" date NOT NULL,
	"description" text NOT NULL,
	"created_by" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" > 0),
	CONSTRAINT "expenses_description_check" CHECK (length("expenses"."description") BETWEEN 3 AND 300 AND "expenses"."description" = btrim("expenses"."description")),
	CONSTRAINT "expenses_void_check" CHECK (num_nonnulls("expenses"."voided_at", "expenses"."voided_by", "expenses"."void_reason") IN (0, 3)
        AND ("expenses"."void_reason" IS NULL OR length("expenses"."void_reason") BETWEEN 3 AND 300))
);
--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_documents_booking_idx" ON "booking_documents" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "expenses_venue_spent_on_idx" ON "expenses" USING btree ("venue_id","spent_on");--> statement-breakpoint
CREATE INDEX "expenses_booking_idx" ON "expenses" USING btree ("booking_id");--> statement-breakpoint
-- Q9-03, P9-05: a document row is never deleted; its only change is being removed once
-- (the file itself is deleted from R2 by the service).
CREATE FUNCTION "booking_documents_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'documents are never deleted (Q9-03)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."removed_at" IS NOT NULL OR NEW."removed_at" IS NULL
		OR (to_jsonb(NEW) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at')
			IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at') THEN
		RAISE EXCEPTION 'a document only changes by being removed once (Q9-03)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "booking_documents_no_delete_or_edit" BEFORE UPDATE OR DELETE ON "booking_documents"
	FOR EACH ROW EXECUTE FUNCTION "booking_documents_guard"();
--> statement-breakpoint
-- BR-95, Q10-04, P9-08: an expense is never deleted or edited; it is voided once with a reason.
CREATE FUNCTION "expenses_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'expenses are never deleted (BR-95)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."voided_at" IS NOT NULL OR NEW."voided_at" IS NULL
		OR (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at')
			IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at') THEN
		RAISE EXCEPTION 'an expense only changes by being voided once (BR-95)' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expenses_no_delete_or_edit" BEFORE UPDATE OR DELETE ON "expenses"
	FOR EACH ROW EXECUTE FUNCTION "expenses_guard"();
