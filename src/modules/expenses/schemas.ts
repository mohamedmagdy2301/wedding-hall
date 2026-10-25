import { z } from "zod";
import { addYears } from "@/lib/time";
import { dateField, id, poundsField } from "@/modules/shared/fields";

// API.md "Expenses" (phase 10, Q10-01..Q10-04). The amount arrives as typed pounds and becomes
// integer piasters here (BR-36); the linked booking is typed by its number (e.g. 2027-0001).

const bookingNoField = z
  .union([z.literal(""), z.null(), z.undefined(), z.string().trim()])
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^\d{4}-\d{4,}$/.test(v), "expenseBookingNotFound");

export const createExpenseSchema = z.object({
  categoryId: id,
  amount: poundsField.refine((v) => v > 0, "expenseAmountInvalid"),
  spentOn: dateField,
  description: z.string().trim().min(3, "expenseDescriptionInvalid").max(300, "expenseDescriptionInvalid"),
  bookingNo: bookingNoField,
});
export type CreateExpenseInput = z.output<typeof createExpenseSchema>;

export const voidExpenseSchema = z.object({
  expenseId: id,
  reason: z.string().trim().min(3, "voidReasonInvalid").max(300, "voidReasonInvalid"),
});
export type VoidExpenseInput = z.output<typeof voidExpenseSchema>;

const optionalId = z
  .union([z.literal(""), z.null(), id])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

const period = { from: dateField, to: dateField };
const validPeriod = (p: { from: string; to: string }) => p.from <= p.to && p.to <= addYears(p.from, 1);
const periodError = { message: "dateRangeInvalid", path: ["to"] };

/** A period of Cairo dates, inclusive, of a year at most. */
export const periodSchema = z.object(period).refine(validPeriod, periodError);

export const listExpensesSchema = z
  .object({ ...period, categoryId: optionalId, bookingId: optionalId })
  .refine(validPeriod, periodError);
export type ListExpensesInput = z.output<typeof listExpensesSchema>;
