CREATE TYPE "public"."space_slot_kind" AS ENUM('day', 'evening');--> statement-breakpoint
CREATE TABLE "cancellation_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"min_days_before" integer NOT NULL,
	"refund_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_tiers_venue_days_unique" UNIQUE("venue_id","min_days_before"),
	CONSTRAINT "cancellation_tiers_min_days_before_check" CHECK ("cancellation_tiers"."min_days_before" BETWEEN 0 AND 730),
	CONSTRAINT "cancellation_tiers_refund_bps_check" CHECK ("cancellation_tiers"."refund_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "event_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_wedding" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_types_name_check" CHECK (length("event_types"."name") BETWEEN 1 AND 80 AND "event_types"."name" = btrim("event_types"."name"))
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_name_check" CHECK (length("expense_categories"."name") BETWEEN 1 AND 80 AND "expense_categories"."name" = btrim("expense_categories"."name"))
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_name_check" CHECK (length("payment_methods"."name") BETWEEN 1 AND 80 AND "payment_methods"."name" = btrim("payment_methods"."name"))
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_dates_check" CHECK ("seasons"."start_date" <= "seasons"."end_date"),
	CONSTRAINT "seasons_name_check" CHECK (length("seasons"."name") BETWEEN 1 AND 80 AND "seasons"."name" = btrim("seasons"."name"))
);
--> statement-breakpoint
CREATE TABLE "space_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "space_slot_kind" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_slots_space_kind_unique" UNIQUE("space_id","kind"),
	CONSTRAINT "space_slots_times_check" CHECK ("space_slots"."start_time" <> "space_slots"."end_time" AND ("space_slots"."kind" = 'evening' OR "space_slots"."start_time" < "space_slots"."end_time"))
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity_max" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_name_check" CHECK (length("spaces"."name") BETWEEN 1 AND 80 AND "spaces"."name" = btrim("spaces"."name")),
	CONSTRAINT "spaces_capacity_max_check" CHECK ("spaces"."capacity_max" IS NULL OR "spaces"."capacity_max" BETWEEN 1 AND 100000)
);
--> statement-breakpoint
ALTER TABLE "cancellation_tiers" ADD CONSTRAINT "cancellation_tiers_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_slots" ADD CONSTRAINT "space_slots_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_slots" ADD CONSTRAINT "space_slots_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_types_venue_name_unique" ON "event_types" USING btree ("venue_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_venue_name_unique" ON "expense_categories" USING btree ("venue_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_venue_name_unique" ON "payment_methods" USING btree ("venue_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_venue_name_unique" ON "seasons" USING btree ("venue_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_venue_name_unique" ON "spaces" USING btree ("venue_id",lower("name"));--> statement-breakpoint
-- BR-31: active seasons of a venue never overlap (inclusive date ranges). Hand-written:
-- drizzle-kit does not model exclusion constraints. btree_gist comes from 0000.
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_no_overlap"
	EXCLUDE USING gist ("venue_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&)
	WHERE ("is_active");
