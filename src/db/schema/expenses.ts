import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bookings } from "./bookings";
import { timestamps } from "./columns";
import { expenseCategories } from "./settings";
import { users } from "./users";
import { venues } from "./venues";

// DATA_MODEL §6 (phase 10). An expense is never deleted or edited; it is voided once with a
// reason (BR-95, Q10-04, trigger in 0010). A linked booking is the venue's, not the customer's:
// it never changes the booking's total or ledger (Q10-02).

const instant = (name: string) => timestamp(name, { withTimezone: true });

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    bookingId: uuid("booking_id").references(() => bookings.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
    ...timestamps,
  },
  (t) => [
    index("expenses_venue_spent_on_idx").on(t.venueId, t.spentOn),
    index("expenses_booking_idx").on(t.bookingId),
    check("expenses_amount_check", sql`${t.amount} > 0`),
    check(
      "expenses_description_check",
      sql`length(${t.description}) BETWEEN 3 AND 300 AND ${t.description} = btrim(${t.description})`,
    ),
    check(
      "expenses_void_check",
      sql`num_nonnulls(${t.voidedAt}, ${t.voidedBy}, ${t.voidReason}) IN (0, 3)
        AND (${t.voidReason} IS NULL OR length(${t.voidReason}) BETWEEN 3 AND 300)`,
    ),
  ],
);
