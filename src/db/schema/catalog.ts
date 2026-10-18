import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { seasons } from "./settings";
import { spaces } from "./spaces";
import { venues } from "./venues";

export const serviceCategoryEnum = pgEnum("service_category", ["service", "show", "hospitality"]);
export const pricingTypeEnum = pgEnum("pricing_type", ["fixed", "per_unit", "per_guest"]);
/** The slot a booking is priced by (BR-30); also used by bookings from phase 5. */
export const slotKindEnum = pgEnum("slot_kind", ["day", "evening", "full_day"]);

const venueId = () =>
  uuid("venue_id")
    .notNull()
    .references(() => venues.id);

const piasters = (name: string) => bigint(name, { mode: "number" });

/** Catalog names: trimmed, 1–80 characters (D-79). */
const nameCheck = (table: string, name: unknown) =>
  check(`${table}_name_check`, sql`length(${name}) BETWEEN 1 AND 80 AND ${name} = btrim(${name})`);

// DATA_MODEL §3. Services and packages are never deleted, only deactivated (D-82).

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    category: serviceCategoryEnum("category").notNull(),
    // Not changed while the service is included in a package (D-80, checked in code).
    pricingType: pricingTypeEnum("pricing_type").notNull(),
    unitPrice: piasters("unit_price").notNull(),
    // Entry fee of an external provider: fixed per booking item, not multiplied (BR-34, D-39).
    externalFee: piasters("external_fee").notNull().default(0),
    allowExternal: boolean("allow_external").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("services_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    nameCheck("services", t.name),
    check("services_unit_price_check", sql`${t.unitPrice} >= 0`),
    check("services_external_fee_check", sql`${t.externalFee} >= 0 AND (${t.allowExternal} OR ${t.externalFee} = 0)`),
  ],
);

/**
 * A customizable template tied to one space (D-10, D-11, D-14). `version` guards concurrent
 * edits of the package with its prices and items (D-81). An active package has a regular
 * price for at least one slot (BR-30, D-78), checked in code under a lock on this row.
 */
export const packages = pgTable(
  "packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    // Fixed at creation (D-77).
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    name: text("name").notNull(),
    description: text("description"),
    baseGuests: integer("base_guests").notNull(),
    extraGuestPrice: piasters("extra_guest_price").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("packages_space_name_unique").on(t.spaceId, sql`lower(${t.name})`),
    nameCheck("packages", t.name),
    check("packages_description_check", sql`${t.description} IS NULL OR length(${t.description}) <= 500`),
    check("packages_base_guests_check", sql`${t.baseGuests} BETWEEN 0 AND 100000`),
    check("packages_extra_guest_price_check", sql`${t.extraGuestPrice} >= 0`),
    check("packages_version_check", sql`${t.version} >= 1`),
  ],
);

/** `season_id` null is the regular price; one price per (slot, season), NULLS NOT DISTINCT. */
export const packagePrices = pgTable(
  "package_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id),
    slotKind: slotKindEnum("slot_kind").notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    price: piasters("price").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("package_prices_package_slot_season_unique").on(t.packageId, t.slotKind, t.seasonId).nullsNotDistinct(),
    check("package_prices_price_check", sql`${t.price} > 0`),
  ],
);

/** Services included in the package price (BR-33); removal credit only when removable. */
export const packageItems = pgTable(
  "package_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    // 1 for fixed and per-guest services (checked in code, D-79).
    quantity: integer("quantity").notNull().default(1),
    removable: boolean("removable").notNull().default(false),
    removalCredit: piasters("removal_credit").notNull().default(0),
    // The package's order of its included services (D-116): rows saved in one transaction
    // share `created_at`, so it cannot order them.
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("package_items_package_service_unique").on(t.packageId, t.serviceId),
    // "How many packages include this service" (D-80).
    index("package_items_service_idx").on(t.serviceId),
    check("package_items_quantity_check", sql`${t.quantity} BETWEEN 1 AND 10000`),
    check(
      "package_items_removal_credit_check",
      sql`${t.removalCredit} >= 0 AND (${t.removable} OR ${t.removalCredit} = 0)`,
    ),
  ],
);
