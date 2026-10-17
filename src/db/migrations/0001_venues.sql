CREATE TYPE "public"."cancellation_basis" AS ENUM('deposit', 'total_paid');--> statement-breakpoint
CREATE TYPE "public"."min_deposit_type" AS ENUM('none', 'fixed', 'percent');--> statement-breakpoint
CREATE TYPE "public"."postpone_credit_mode" AS ENUM('refund', 'services', 'both');--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"logo_key" text,
	"phone" text,
	"address" text,
	"timezone" text DEFAULT 'Africa/Cairo' NOT NULL,
	"currency" text DEFAULT 'EGP' NOT NULL,
	"buffer_minutes" integer NOT NULL,
	"tentative_hold_hours" integer NOT NULL,
	"min_deposit_type" "min_deposit_type" NOT NULL,
	"min_deposit_value" bigint NOT NULL,
	"cancellation_basis" "cancellation_basis" NOT NULL,
	"postpone_credit_mode" "postpone_credit_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venues_buffer_minutes_check" CHECK ("venues"."buffer_minutes" >= 0),
	CONSTRAINT "venues_tentative_hold_hours_check" CHECK ("venues"."tentative_hold_hours" > 0),
	CONSTRAINT "venues_min_deposit_value_check" CHECK ("venues"."min_deposit_value" >= 0 AND ("venues"."min_deposit_type" <> 'percent' OR "venues"."min_deposit_value" <= 10000))
);
