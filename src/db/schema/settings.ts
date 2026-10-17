import { sql } from "drizzle-orm";
import { boolean, check, date, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { venues } from "./venues";

const venueId = () =>
  uuid("venue_id")
    .notNull()
    .references(() => venues.id);

/** Settings list names: trimmed, 1–80 characters (P2-14). */
const nameCheck = (table: string, name: unknown) =>
  check(`${table}_name_check`, sql`length(${name}) BETWEEN 1 AND 80 AND ${name} = btrim(${name})`);

// DATA_MODEL §1. Names are unique per venue, case-insensitive, including inactive rows (D-72).

/**
 * The venue's current policy for bookings confirmed from now on; each confirmed booking
 * carries its own snapshot (D-68). Replaced as a whole set; BR-77 ordering is checked in code.
 */
export const cancellationTiers = pgTable(
  "cancellation_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    minDaysBefore: integer("min_days_before").notNull(),
    refundBps: integer("refund_bps").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("cancellation_tiers_venue_days_unique").on(t.venueId, t.minDaysBefore),
    check("cancellation_tiers_min_days_before_check", sql`${t.minDaysBefore} BETWEEN 0 AND 730`),
    check("cancellation_tiers_refund_bps_check", sql`${t.refundBps} BETWEEN 0 AND 10000`),
  ],
);

/** Active seasons never overlap: `seasons_no_overlap` exclusion constraint (hand-written in 0003, BR-31). */
export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("seasons_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    check("seasons_dates_check", sql`${t.startDate} <= ${t.endDate}`),
    nameCheck("seasons", t.name),
  ],
);

export const eventTypes = pgTable(
  "event_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    // Groom and bride names are required to confirm a wedding (BR-21).
    isWedding: boolean("is_wedding").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("event_types_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    nameCheck("event_types", t.name),
  ],
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payment_methods_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    nameCheck("payment_methods", t.name),
  ],
);

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("expense_categories_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    nameCheck("expense_categories", t.name),
  ],
);
