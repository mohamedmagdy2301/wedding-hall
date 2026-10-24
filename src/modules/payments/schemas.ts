import { z } from "zod";
import { MAX_INSTALLMENTS } from "@/domain/installments";
import { nullableText } from "@/modules/customers/schemas";
import { dateField, id, intField, poundsField } from "@/modules/shared/fields";

// API.md "Payments" (D-118, D-121, D-126). Amounts arrive as typed pounds and become integer
// piasters here (BR-36), like every money field of the system.

/** A payment amount: pounds as typed → piasters, more than zero. */
export const paymentAmount = poundsField.refine((v) => v > 0, "amountInvalid");

/** A past payment date (Cairo, `payments.backdate` — D-118); empty = now. */
export const paidAtField = z
  .union([z.literal(""), z.null(), dateField])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

export const scheduleLineSchema = z.object({ dueDate: dateField, amount: paymentAmount });
export const scheduleSchema = z.array(scheduleLineSchema).max(MAX_INSTALLMENTS, "tooManyInstallments");

export const depositSchema = z.object({ amount: paymentAmount, methodId: id, paidAt: paidAtField });
export type DepositInput = z.output<typeof depositSchema>;

export const recordPaymentSchema = z.object({
  bookingId: id,
  amount: paymentAmount,
  methodId: id,
  paidAt: paidAtField,
  note: nullableText(300),
});
export type RecordPaymentInput = z.output<typeof recordPaymentSchema>;

/** Without `installments` an existing schedule is rebalanced (D-121); with them they are checked as sent. */
export const recordDepositSchema = recordPaymentSchema.extend({ installments: scheduleSchema.optional() });
export type RecordDepositInput = z.output<typeof recordDepositSchema>;

/** `payments.refund` (BR-83, D-126): a credit for the customer paid back, with its reason. */
export const refundSchema = z.object({
  bookingId: id,
  amount: paymentAmount,
  methodId: id,
  reason: z.string().trim().min(3, "refundReasonInvalid").max(300, "refundReasonInvalid"),
});
export type RefundInput = z.output<typeof refundSchema>;

export const voidPaymentSchema = z.object({
  paymentId: id,
  reason: z.string().trim().min(3, "voidReasonInvalid").max(300, "voidReasonInvalid"),
});
export type VoidPaymentInput = z.output<typeof voidPaymentSchema>;

export const setInstallmentsSchema = z.object({
  bookingId: id,
  version: intField(1, 2_147_483_647),
  installments: scheduleSchema,
});
export type SetInstallmentsInput = z.output<typeof setInstallmentsSchema>;

export const paymentIdSchema = z.object({ paymentId: id });

export const collectionsSchema = z.object({
  from: z.union([z.literal(""), dateField]).default(""),
  to: z.union([z.literal(""), dateField]).default(""),
});
export type CollectionsFilters = z.output<typeof collectionsSchema>;
