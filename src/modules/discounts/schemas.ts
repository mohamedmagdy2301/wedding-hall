import { z } from "zod";
import { nullableText } from "@/modules/customers/schemas";
import { id } from "@/modules/shared/fields";
import { paymentAmount } from "@/modules/payments/schemas";

// API.md "Discounts" (BR-50..52, D-129). The amount arrives as typed pounds → piasters.

export const discountReason = z.string().trim().min(3, "discountReasonInvalid").max(300, "discountReasonInvalid");

const optionalId = z
  .union([z.literal(""), z.null(), id])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

/** How a credit for the customer is settled (BR-83, D-36): needed only when one arises. */
export const creditSchema = z
  .object({ resolution: z.enum(["refund", "services"]), methodId: optionalId })
  .nullable()
  .optional()
  .transform((v) => v ?? null);

export const requestDiscountSchema = z.object({
  bookingId: id,
  amount: paymentAmount,
  reason: discountReason,
  credit: creditSchema,
});
export type RequestDiscountInput = z.output<typeof requestDiscountSchema>;

export const decideDiscountSchema = z.object({
  requestId: id,
  approve: z.boolean(),
  note: nullableText(300),
  credit: creditSchema,
});
export type DecideDiscountInput = z.output<typeof decideDiscountSchema>;

export const withdrawDiscountSchema = z.object({ requestId: id });

export const listPendingSchema = z.object({});
