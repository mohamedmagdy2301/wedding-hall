import { z } from "zod";
import { MAX_TIER_DAYS, MAX_TIERS } from "@/domain/cancellation-tiers";
import { toAsciiDigits } from "@/lib/digits";
import { dateField, id, intField, listName, optionalText, percentField, poundsField } from "@/modules/shared/fields";

// Ranges from PHASE2_PLAN P2-14. Messages are i18n keys (errors.messages).

export const MAX_BUFFER_MINUTES = 720;
export const MAX_TENTATIVE_HOLD_HOURS = 720;

/** Landline or mobile as typed (D-52 normalization is for customers and logins only). */
const venuePhone = optionalText(30)
  .transform((v) => (v === null ? null : toAsciiDigits(v)))
  .refine((v) => v === null || /^\+?[\d\s\-()]{3,30}$/.test(v), "phoneInvalid");

export const updateVenueSchema = z.object({
  name: listName,
  phone: venuePhone,
  address: optionalText(200),
});

export const updateTimingSchema = z.object({
  bufferMinutes: intField(0, MAX_BUFFER_MINUTES),
  tentativeHoldHours: intField(1, MAX_TENTATIVE_HOLD_HOURS),
});

const tierSchema = z.object({
  minDaysBefore: intField(0, MAX_TIER_DAYS),
  refundBps: percentField,
});

/**
 * D-19: `minDepositValue` is pounds when fixed (> 0), a percentage when percent (0.01–100%),
 * and ignored when none. BR-77 on the tiers is checked by the service (domain function).
 */
export const updatePoliciesSchema = z
  .object({
    minDepositType: z.enum(["none", "fixed", "percent"]),
    minDepositValue: z.union([z.string(), z.number()]).optional(),
    cancellationBasis: z.enum(["deposit", "total_paid"]),
    postponeCreditMode: z.enum(["refund", "services", "both"]),
    tiers: z.array(tierSchema).max(MAX_TIERS, "tooManyTiers"),
  })
  .transform((input, ctx) => {
    let minDepositValue = 0;
    if (input.minDepositType !== "none") {
      const field = input.minDepositType === "fixed" ? poundsField : percentField;
      const parsed = field.safeParse(input.minDepositValue ?? "");
      if (!parsed.success || parsed.data <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["minDepositValue"],
          message: input.minDepositType === "fixed" ? "amountInvalid" : "percentInvalid",
        });
        return z.NEVER;
      }
      minDepositValue = parsed.data;
    }
    return { ...input, minDepositValue };
  });

/** Event types, payment methods and expense categories (S-13). */
export const LIST_KINDS = ["eventTypes", "paymentMethods", "expenseCategories"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

const listKind = z.enum(LIST_KINDS);
export const createListItemSchema = z.object({ kind: listKind, name: listName, isWedding: z.boolean().optional() });
export const updateListItemSchema = z.object({
  kind: listKind,
  id,
  name: listName,
  isWedding: z.boolean().optional(),
});
export const setListItemActiveSchema = z.object({ kind: listKind, id, active: z.boolean() });
export const moveListItemSchema = z.object({ kind: listKind, id, direction: z.enum(["up", "down"]) });
export const listKindSchema = z.object({ kind: listKind });

const seasonInputSchema = z
  .object({ name: listName, startDate: dateField, endDate: dateField })
  .refine((s) => s.startDate <= s.endDate, { path: ["endDate"], message: "dateOrder" });
export const createSeasonSchema = seasonInputSchema;
export const updateSeasonSchema = z
  .object({ seasonId: id, name: listName, startDate: dateField, endDate: dateField })
  .refine((s) => s.startDate <= s.endDate, { path: ["endDate"], message: "dateOrder" });
export const setSeasonActiveSchema = z.object({ seasonId: id, active: z.boolean() });
