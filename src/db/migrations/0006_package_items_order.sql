ALTER TABLE "package_items" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- D-116: existing rows get an order per package. Rows saved in the same transaction share
-- created_at, so the id breaks the tie: stable from now on, and editable by saving the package.
UPDATE "package_items" AS "pi" SET "sort_order" = "ordered"."n"
FROM (
	SELECT "id", (row_number() OVER (PARTITION BY "package_id" ORDER BY "created_at", "id") - 1)::integer AS "n"
	FROM "package_items"
) AS "ordered"
WHERE "pi"."id" = "ordered"."id";
