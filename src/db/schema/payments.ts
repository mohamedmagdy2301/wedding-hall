import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./bookings";
import { timestamps } from "./columns";
import { paymentMethods } from "./settings";
import { users } from "./users";
import { venues } from "./venues";

// DATA_MODEL §5. Payments are never deleted, and only voiding changes one (D-125, trigger in 0007).

/** `refund` is recorded from phases 7/8 (D-126); the ledger counts it from now. */
export const paymentKindEnum = pgEnum("payment_kind", ["deposit", "installment", "payment", "refund"]);

const venueId = () =>
  uuid("venue_id")
    .notNull()
    .references(() => venues.id);

const piasters = (name: string) => bigint(name, { mode: "number" });
const instant = (name: string) => timestamp(name, { withTimezone: true });

/** The venue's next receipt number (BR-61, D-125): one counter, never reset, taken inside the paying transaction. */
export const receiptCounters = pgTable(
  "receipt_counters",
  {
    venueId: uuid("venue_id")
      .primaryKey()
      .references(() => venues.id),
    lastNo: integer("last_no").notNull(),
    ...timestamps,
  },
  (t) => [check("receipt_counters_last_no_check", sql`${t.lastNo} >= 1`)],
);

/**
 * The ledger (BR-62): paid and remaining are computed from these rows and never stored.
 * `amount` is always positive; `kind` gives the direction.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    receiptNo: text("receipt_no").notNull(),
    kind: paymentKindEnum("kind").notNull(),
    amount: piasters("amount").notNull(),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id),
    paidAt: instant("paid_at").notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
    ...timestamps,
  },
  (t) => [
    unique("payments_venue_receipt_no_unique").on(t.venueId, t.receiptNo),
    index("payments_booking_idx").on(t.bookingId),
    index("payments_paid_at_idx").on(t.paidAt),
    check("payments_receipt_no_check", sql`${t.receiptNo} ~ '^[0-9]{6,}$'`),
    check("payments_amount_check", sql`${t.amount} > 0`),
    check(
      "payments_void_check",
      sql`num_nonnulls(${t.voidedAt}, ${t.voidedBy}, ${t.voidReason}) IN (0, 3)
        AND (${t.voidReason} IS NULL OR length(${t.voidReason}) BETWEEN 3 AND 300)`,
    ),
    check("payments_note_check", sql`${t.note} IS NULL OR length(${t.note}) <= 300`),
  ],
);

/** The optional schedule after the deposit (BR-65): deposit + Σ amounts = total, last due ≤ party day − 1. */
export const installments = pgTable(
  "installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: venueId(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    amount: piasters("amount").notNull(),
    sortOrder: integer("sort_order").notNull(),
    ...timestamps,
  },
  (t) => [
    index("installments_booking_idx").on(t.bookingId),
    index("installments_due_date_idx").on(t.dueDate),
    check("installments_amount_check", sql`${t.amount} > 0`),
  ],
);
