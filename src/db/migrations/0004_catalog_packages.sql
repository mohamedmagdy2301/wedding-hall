CREATE TYPE "public"."pricing_type" AS ENUM('fixed', 'per_unit', 'per_guest');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('service', 'show', 'hospitality');--> statement-breakpoint
CREATE TYPE "public"."slot_kind" AS ENUM('day', 'evening', 'full_day');--> statement-breakpoint
CREATE TABLE "package_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"removable" boolean DEFAULT false NOT NULL,
	"removal_credit" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_items_package_service_unique" UNIQUE("package_id","service_id"),
	CONSTRAINT "package_items_quantity_check" CHECK ("package_items"."quantity" BETWEEN 1 AND 10000),
	CONSTRAINT "package_items_removal_credit_check" CHECK ("package_items"."removal_credit" >= 0 AND ("package_items"."removable" OR "package_items"."removal_credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "package_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"slot_kind" "slot_kind" NOT NULL,
	"season_id" uuid,
	"price" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_prices_package_slot_season_unique" UNIQUE NULLS NOT DISTINCT("package_id","slot_kind","season_id"),
	CONSTRAINT "package_prices_price_check" CHECK ("package_prices"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_guests" integer NOT NULL,
	"extra_guest_price" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_name_check" CHECK (length("packages"."name") BETWEEN 1 AND 80 AND "packages"."name" = btrim("packages"."name")),
	CONSTRAINT "packages_description_check" CHECK ("packages"."description" IS NULL OR length("packages"."description") <= 500),
	CONSTRAINT "packages_base_guests_check" CHECK ("packages"."base_guests" BETWEEN 0 AND 100000),
	CONSTRAINT "packages_extra_guest_price_check" CHECK ("packages"."extra_guest_price" >= 0),
	CONSTRAINT "packages_version_check" CHECK ("packages"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "service_category" NOT NULL,
	"pricing_type" "pricing_type" NOT NULL,
	"unit_price" bigint NOT NULL,
	"external_fee" bigint DEFAULT 0 NOT NULL,
	"allow_external" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_name_check" CHECK (length("services"."name") BETWEEN 1 AND 80 AND "services"."name" = btrim("services"."name")),
	CONSTRAINT "services_unit_price_check" CHECK ("services"."unit_price" >= 0),
	CONSTRAINT "services_external_fee_check" CHECK ("services"."external_fee" >= 0 AND ("services"."allow_external" OR "services"."external_fee" = 0))
);
--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_prices" ADD CONSTRAINT "package_prices_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_prices" ADD CONSTRAINT "package_prices_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_prices" ADD CONSTRAINT "package_prices_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_items_service_idx" ON "package_items" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_space_name_unique" ON "packages" USING btree ("space_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "services_venue_name_unique" ON "services" USING btree ("venue_id",lower("name"));--> statement-breakpoint
-- D-82: services and packages are never deleted, only deactivated (bookings will point at
-- them). Hand-written: drizzle-kit does not model triggers. TRUNCATE (tests) is unaffected.
CREATE FUNCTION "catalog_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are never deleted (D-82): deactivate instead', TG_TABLE_NAME
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "services_no_delete" BEFORE DELETE ON "services"
	FOR EACH ROW EXECUTE FUNCTION "catalog_reject_delete"();
--> statement-breakpoint
CREATE TRIGGER "packages_no_delete" BEFORE DELETE ON "packages"
	FOR EACH ROW EXECUTE FUNCTION "catalog_reject_delete"();
