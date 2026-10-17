import { sql } from "drizzle-orm";
import { bigint, check, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const minDepositTypeEnum = pgEnum("min_deposit_type", ["none", "fixed", "percent"]);
export const cancellationBasisEnum = pgEnum("cancellation_basis", ["deposit", "total_paid"]);
export const postponeCreditModeEnum = pgEnum("postpone_credit_mode", ["refund", "services", "both"]);

// DATA_MODEL §1. Numbering counters (booking/receipt) are added with their phases (5/6).
export const venues = pgTable(
  "venues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    logoKey: text("logo_key"),
    phone: text("phone"),
    address: text("address"),
    timezone: text("timezone").notNull().default("Africa/Cairo"),
    currency: text("currency").notNull().default("EGP"),
    bufferMinutes: integer("buffer_minutes").notNull(),
    tentativeHoldHours: integer("tentative_hold_hours").notNull(),
    minDepositType: minDepositTypeEnum("min_deposit_type").notNull(),
    // Piasters when `fixed`, basis points when `percent`.
    minDepositValue: bigint("min_deposit_value", { mode: "number" }).notNull(),
    cancellationBasis: cancellationBasisEnum("cancellation_basis").notNull(),
    postponeCreditMode: postponeCreditModeEnum("postpone_credit_mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("venues_buffer_minutes_check", sql`${t.bufferMinutes} >= 0`),
    check("venues_tentative_hold_hours_check", sql`${t.tentativeHoldHours} > 0`),
    check(
      "venues_min_deposit_value_check",
      sql`${t.minDepositValue} >= 0 AND (${t.minDepositType} <> 'percent' OR ${t.minDepositValue} <= 10000)`,
    ),
  ],
);
