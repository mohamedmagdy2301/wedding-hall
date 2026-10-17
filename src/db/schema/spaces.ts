import { sql } from "drizzle-orm";
import { boolean, check, integer, pgEnum, pgTable, text, time, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { venues } from "./venues";

export const spaceSlotKindEnum = pgEnum("space_slot_kind", ["day", "evening"]);

// DATA_MODEL §2.
export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    name: text("name").notNull(),
    // Optional; enforced on bookings (BR-05, phase 5).
    capacityMax: integer("capacity_max"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("spaces_venue_name_unique").on(t.venueId, sql`lower(${t.name})`),
    check("spaces_name_check", sql`length(${t.name}) BETWEEN 1 AND 80 AND ${t.name} = btrim(${t.name})`),
    check("spaces_capacity_max_check", sql`${t.capacityMax} IS NULL OR ${t.capacityMax} BETWEEN 1 AND 100000`),
  ],
);

/**
 * Every space has both slots (BR-01), created with it. Only the evening slot may cross
 * midnight (`end_time < start_time`, D-69); BR-02 against the buffer is checked in code
 * under a lock on the venue row.
 */
export const spaceSlots = pgTable(
  "space_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    kind: spaceSlotKindEnum("kind").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("space_slots_space_kind_unique").on(t.spaceId, t.kind),
    check(
      "space_slots_times_check",
      sql`${t.startTime} <> ${t.endTime} AND (${t.kind} = 'evening' OR ${t.startTime} < ${t.endTime})`,
    ),
  ],
);
