CREATE TYPE "public"."booking_item_source" AS ENUM('package', 'added', 'guest_adjustment');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('tentative', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "booking_counters" (
	"venue_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_counters_venue_id_year_pk" PRIMARY KEY("venue_id","year"),
	CONSTRAINT "booking_counters_last_no_check" CHECK ("booking_counters"."last_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "booking_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"category" "service_category" NOT NULL,
	"pricing_type" "pricing_type" NOT NULL,
	"unit_price" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"source" "booking_item_source" NOT NULL,
	"is_removed" boolean DEFAULT false NOT NULL,
	"removal_credit" bigint DEFAULT 0 NOT NULL,
	"is_external" boolean DEFAULT false NOT NULL,
	"external_fee" bigint DEFAULT 0 NOT NULL,
	"line_total" bigint NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_items_quantity_check" CHECK ("booking_items"."quantity" BETWEEN 1 AND 100000),
	CONSTRAINT "booking_items_amounts_check" CHECK ("booking_items"."unit_price" >= 0 AND "booking_items"."removal_credit" >= 0 AND "booking_items"."external_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_no" text NOT NULL,
	"space_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"event_type_id" uuid,
	"groom_name" text,
	"bride_name" text,
	"slot_kind" "slot_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"guests" integer,
	"package_id" uuid,
	"status" "booking_status" DEFAULT 'tentative' NOT NULL,
	"tentative_expires_at" timestamp with time zone,
	"season_id" uuid,
	"base_price" bigint,
	"extra_guests_amount" bigint,
	"items_total" bigint,
	"removal_credits_total" bigint,
	"discount_amount" bigint,
	"total" bigint,
	"base_guests" integer,
	"extra_guest_price" bigint,
	"cancellation_basis" "cancellation_basis",
	"cancellation_tiers" jsonb,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_venue_booking_no_unique" UNIQUE("venue_id","booking_no"),
	CONSTRAINT "bookings_booking_no_check" CHECK ("bookings"."booking_no" ~ '^[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "bookings_times_check" CHECK ("bookings"."ends_at" > "bookings"."starts_at" AND "bookings"."ends_at" - "bookings"."starts_at" <= interval '24 hours' AND "bookings"."blocked_until" >= "bookings"."ends_at"),
	CONSTRAINT "bookings_guests_check" CHECK ("bookings"."guests" IS NULL OR "bookings"."guests" BETWEEN 1 AND 100000),
	CONSTRAINT "bookings_price_check" CHECK (("bookings"."package_id" IS NULL AND "bookings"."season_id" IS NULL AND num_nonnulls("bookings"."base_price", "bookings"."extra_guests_amount",
          "bookings"."items_total", "bookings"."removal_credits_total", "bookings"."discount_amount", "bookings"."total", "bookings"."base_guests", "bookings"."extra_guest_price") = 0)
      OR ("bookings"."package_id" IS NOT NULL AND "bookings"."guests" IS NOT NULL AND num_nulls("bookings"."base_price", "bookings"."extra_guests_amount",
          "bookings"."items_total", "bookings"."removal_credits_total", "bookings"."discount_amount", "bookings"."total", "bookings"."base_guests", "bookings"."extra_guest_price") = 0)),
	CONSTRAINT "bookings_amounts_check" CHECK ("bookings"."base_price" >= 0 AND "bookings"."extra_guests_amount" >= 0 AND "bookings"."items_total" >= 0 AND "bookings"."removal_credits_total" >= 0
        AND "bookings"."discount_amount" >= 0 AND "bookings"."total" >= 0 AND "bookings"."base_guests" >= 0 AND "bookings"."extra_guest_price" >= 0),
	CONSTRAINT "bookings_confirmed_check" CHECK ("bookings"."status" <> 'confirmed' OR ("bookings"."event_type_id" IS NOT NULL AND "bookings"."package_id" IS NOT NULL
        AND "bookings"."guests" IS NOT NULL AND "bookings"."total" IS NOT NULL AND "bookings"."confirmed_at" IS NOT NULL
        AND "bookings"."confirmed_by" IS NOT NULL AND "bookings"."cancellation_basis" IS NOT NULL AND "bookings"."cancellation_tiers" IS NOT NULL)),
	CONSTRAINT "bookings_tentative_check" CHECK ("bookings"."status" <> 'tentative' OR "bookings"."tentative_expires_at" IS NOT NULL),
	CONSTRAINT "bookings_cancelled_check" CHECK ("bookings"."status" <> 'cancelled' OR ("bookings"."cancelled_at" IS NOT NULL AND "bookings"."cancelled_by" IS NOT NULL AND "bookings"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "bookings_names_check" CHECK (("bookings"."groom_name" IS NULL OR length("bookings"."groom_name") BETWEEN 1 AND 80)
        AND ("bookings"."bride_name" IS NULL OR length("bookings"."bride_name") BETWEEN 1 AND 80)),
	CONSTRAINT "bookings_notes_check" CHECK ("bookings"."notes" IS NULL OR length("bookings"."notes") <= 1000),
	CONSTRAINT "bookings_version_check" CHECK ("bookings"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"alt_phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_name_check" CHECK (length("customers"."name") BETWEEN 1 AND 80 AND "customers"."name" = btrim("customers"."name")),
	CONSTRAINT "customers_phone_check" CHECK ("customers"."phone" ~ '^01[0125][0-9]{8}$' AND ("customers"."alt_phone" IS NULL OR "customers"."alt_phone" ~ '^01[0125][0-9]{8}$')),
	CONSTRAINT "customers_notes_check" CHECK ("customers"."notes" IS NULL OR length("customers"."notes") <= 500)
);
--> statement-breakpoint
ALTER TABLE "booking_counters" ADD CONSTRAINT "booking_counters_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_items_booking_idx" ON "booking_items" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "bookings_space_starts_idx" ON "bookings" USING btree ("space_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_status_starts_idx" ON "bookings" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_venue_phone_idx" ON "customers" USING btree ("venue_id","phone");--> statement-breakpoint
CREATE INDEX "customers_venue_alt_phone_idx" ON "customers" USING btree ("venue_id","alt_phone");--> statement-breakpoint
-- BR-11 (T-07, CLAUDE.md rule 3): two confirmed bookings of a space never overlap on
-- [starts_at, blocked_until). Hand-written: drizzle-kit does not model exclusion
-- constraints. btree_gist comes from 0000. Completed bookings are confirmed ones in the
-- past, so they stay covered.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
	EXCLUDE USING gist ("space_id" WITH =, tstzrange("starts_at", "blocked_until", '[)') WITH &&)
	WHERE ("status" = 'confirmed');
--> statement-breakpoint
-- D-107 (CLAUDE.md rule 4): customers and bookings are never deleted; booking lines only
-- while the booking is tentative (editing it replaces its lines). TRUNCATE is unaffected.
CREATE FUNCTION "bookings_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are never deleted (D-107)', TG_TABLE_NAME
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "customers_no_delete" BEFORE DELETE ON "customers"
	FOR EACH ROW EXECUTE FUNCTION "bookings_reject_delete"();
--> statement-breakpoint
CREATE TRIGGER "bookings_no_delete" BEFORE DELETE ON "bookings"
	FOR EACH ROW EXECUTE FUNCTION "bookings_reject_delete"();
--> statement-breakpoint
CREATE FUNCTION "booking_items_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "status" FROM "bookings" WHERE "id" = OLD."booking_id") <> 'tentative' THEN
		RAISE EXCEPTION 'lines of a booking that is not tentative are never deleted (D-107)'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "booking_items_no_delete" BEFORE DELETE ON "booking_items"
	FOR EACH ROW EXECUTE FUNCTION "booking_items_reject_delete"();
