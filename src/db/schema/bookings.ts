import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { packages, pricingTypeEnum, serviceCategoryEnum, services, slotKindEnum } from "./catalog";
import { timestamps } from "./columns";
import { eventTypes, seasons } from "./settings";
import { spaces } from "./spaces";
import { users } from "./users";
import { cancellationBasisEnum, venues } from "./venues";

export const bookingStatusEnum = pgEnum("booking_status", ["tentative", "confirmed", "cancelled"]);
/** `guest_adjustment` lines come with phase 7 (D-35); the value exists now so the enum never changes. */
export const bookingItemSourceEnum = pgEnum("booking_item_source", ["package", "added", "guest_adjustment"]);

const venueId = () =>
  uuid("venue_id")
    .notNull()
    .references(() => venues.id);

const piasters = (name: string) => bigint(name, { mode: "number" });
const instant = (name: string) => timestamp(name, { withTimezone: true });

const MOBILE = sql.raw(`'^01[0125][0-9]{8}$'`);

// DATA_MODEL §4. Customers, bookings and their lines are never deleted (D-107, triggers in 0005).

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    // Normalized 01XXXXXXXXX (D-52, D-106); not unique (D-28).
    phone: text("phone").notNull(),
    altPhone: text("alt_phone"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("customers_venue_phone_idx").on(t.venueId, t.phone),
    index("customers_venue_alt_phone_idx").on(t.venueId, t.altPhone),
    check("customers_name_check", sql`length(${t.name}) BETWEEN 1 AND 80 AND ${t.name} = btrim(${t.name})`),
    check(
      "customers_phone_check",
      sql`${t.phone} ~ ${MOBILE} AND (${t.altPhone} IS NULL OR ${t.altPhone} ~ ${MOBILE})`,
    ),
    check("customers_notes_check", sql`${t.notes} IS NULL OR length(${t.notes}) <= 500`),
  ],
);

/** Next booking number per venue and Cairo year (BR-26, D-105), taken inside the creating transaction. */
export const bookingCounters = pgTable(
  "booking_counters",
  {
    venueId: venueId(),
    year: integer("year").notNull(),
    lastNo: integer("last_no").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.venueId, t.year] }), check("booking_counters_last_no_check", sql`${t.lastNo} >= 1`)],
);

/**
 * A booking (BUSINESS_RULES §3). `bookings_no_overlap` (BR-11, hand-written in 0005) keeps
 * two confirmed bookings of a space from overlapping on `[starts_at, blocked_until)`.
 * The price columns are the last quote of a tentative booking and the fixed snapshot of a
 * confirmed one (BR-37, D-41); all empty without a package (D-103).
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    bookingNo: text("booking_no").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    eventTypeId: uuid("event_type_id").references(() => eventTypes.id),
    groomName: text("groom_name"),
    brideName: text("bride_name"),
    slotKind: slotKindEnum("slot_kind").notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    // ends_at + the buffer at save time (BR-10, D-110).
    blockedUntil: instant("blocked_until").notNull(),
    guests: integer("guests"),
    packageId: uuid("package_id").references(() => packages.id),
    status: bookingStatusEnum("status").notNull().default("tentative"),
    tentativeExpiresAt: instant("tentative_expires_at"),
    // The season whose price applied; empty with the regular price (D-88).
    seasonId: uuid("season_id").references(() => seasons.id),
    basePrice: piasters("base_price"),
    extraGuestsAmount: piasters("extra_guests_amount"),
    itemsTotal: piasters("items_total"),
    removalCreditsTotal: piasters("removal_credits_total"),
    discountAmount: piasters("discount_amount"),
    total: piasters("total"),
    baseGuests: integer("base_guests"),
    extraGuestPrice: piasters("extra_guest_price"),
    // Cancellation policy snapshot at confirmation (D-68, phase 6).
    cancellationBasis: cancellationBasisEnum("cancellation_basis"),
    cancellationTiers: jsonb("cancellation_tiers"),
    cancelledAt: instant("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    confirmedAt: instant("confirmed_at"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique("bookings_venue_booking_no_unique").on(t.venueId, t.bookingNo),
    index("bookings_space_starts_idx").on(t.spaceId, t.startsAt),
    index("bookings_status_starts_idx").on(t.status, t.startsAt),
    index("bookings_customer_idx").on(t.customerId),
    check("bookings_booking_no_check", sql`${t.bookingNo} ~ '^[0-9]{4}-[0-9]{4,}$'`),
    // BR-04, D-37, BR-10.
    check(
      "bookings_times_check",
      sql`${t.endsAt} > ${t.startsAt} AND ${t.endsAt} - ${t.startsAt} <= interval '24 hours' AND ${t.blockedUntil} >= ${t.endsAt}`,
    ),
    check("bookings_guests_check", sql`${t.guests} IS NULL OR ${t.guests} BETWEEN 1 AND 100000`),
    // D-103: the price group is all empty without a package and complete with one. num_nulls,
    // not `x >= 0`: a CHECK passes when its expression is NULL.
    check(
      "bookings_price_check",
      sql`(${t.packageId} IS NULL AND ${t.seasonId} IS NULL AND num_nonnulls(${t.basePrice}, ${t.extraGuestsAmount},
          ${t.itemsTotal}, ${t.removalCreditsTotal}, ${t.discountAmount}, ${t.total}, ${t.baseGuests}, ${t.extraGuestPrice}) = 0)
      OR (${t.packageId} IS NOT NULL AND ${t.guests} IS NOT NULL AND num_nulls(${t.basePrice}, ${t.extraGuestsAmount},
          ${t.itemsTotal}, ${t.removalCreditsTotal}, ${t.discountAmount}, ${t.total}, ${t.baseGuests}, ${t.extraGuestPrice}) = 0)`,
    ),
    check(
      "bookings_amounts_check",
      sql`${t.basePrice} >= 0 AND ${t.extraGuestsAmount} >= 0 AND ${t.itemsTotal} >= 0 AND ${t.removalCreditsTotal} >= 0
        AND ${t.discountAmount} >= 0 AND ${t.total} >= 0 AND ${t.baseGuests} >= 0 AND ${t.extraGuestPrice} >= 0`,
    ),
    // D-98: nothing confirms an incomplete booking (BR-21, BR-22, D-68).
    check(
      "bookings_confirmed_check",
      sql`${t.status} <> 'confirmed' OR (${t.eventTypeId} IS NOT NULL AND ${t.packageId} IS NOT NULL
        AND ${t.guests} IS NOT NULL AND ${t.total} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL
        AND ${t.confirmedBy} IS NOT NULL AND ${t.cancellationBasis} IS NOT NULL AND ${t.cancellationTiers} IS NOT NULL)`,
    ),
    check("bookings_tentative_check", sql`${t.status} <> 'tentative' OR ${t.tentativeExpiresAt} IS NOT NULL`),
    check(
      "bookings_cancelled_check",
      sql`${t.status} <> 'cancelled' OR (${t.cancelledAt} IS NOT NULL AND ${t.cancelledBy} IS NOT NULL AND ${t.cancelReason} IS NOT NULL)`,
    ),
    check(
      "bookings_names_check",
      sql`(${t.groomName} IS NULL OR length(${t.groomName}) BETWEEN 1 AND 80)
        AND (${t.brideName} IS NULL OR length(${t.brideName}) BETWEEN 1 AND 80)`,
    ),
    check("bookings_notes_check", sql`${t.notes} IS NULL OR length(${t.notes}) <= 1000`),
    check("bookings_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * The lines of a booking's price, stored as the engine's `PriceLine` without recomputing
 * (PHASE4_PLAN §3, D-84): `unit_price` is what the venue charges per unit (0 for included and
 * external lines), `line_total` is signed. Deleted only while the booking is tentative (D-107).
 */
export const bookingItems = pgTable(
  "booking_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    // Always set: re-pricing at confirmation finds added and removed lines by service (D-86, D-95).
    serviceId: uuid("service_id").references(() => services.id),
    name: text("name").notNull(),
    category: serviceCategoryEnum("category").notNull(),
    pricingType: pricingTypeEnum("pricing_type").notNull(),
    unitPrice: piasters("unit_price").notNull(),
    quantity: integer("quantity").notNull(),
    source: bookingItemSourceEnum("source").notNull(),
    isRemoved: boolean("is_removed").notNull().default(false),
    removalCredit: piasters("removal_credit").notNull().default(0),
    isExternal: boolean("is_external").notNull().default(false),
    externalFee: piasters("external_fee").notNull().default(0),
    lineTotal: piasters("line_total").notNull(),
    // The engine's line order: included lines in package order, then added lines.
    sortOrder: integer("sort_order").notNull(),
    ...timestamps,
  },
  (t) => [
    index("booking_items_booking_idx").on(t.bookingId),
    check("booking_items_quantity_check", sql`${t.quantity} BETWEEN 1 AND 100000`),
    check(
      "booking_items_amounts_check",
      sql`${t.unitPrice} >= 0 AND ${t.removalCredit} >= 0 AND ${t.externalFee} >= 0`,
    ),
  ],
);
