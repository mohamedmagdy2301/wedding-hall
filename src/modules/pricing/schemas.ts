import { z } from "zod";
import { MAX_ITEM_QUANTITY, SLOT_KINDS } from "@/domain/catalog";
import { MAX_GUESTS, MAX_QUOTE_ITEMS } from "@/domain/pricing";
import { dateField, id, intField, nonNegativePoundsField } from "@/modules/shared/fields";

// API.md "Pricing" with D-86 / D-87. Item rules by pricing type are the engine's (D-90).

const addedItem = z.object({
  serviceId: id,
  quantity: intField(1, MAX_ITEM_QUANTITY),
  isExternal: z.boolean(),
});

export const quoteSchema = z.object({
  spaceId: id,
  packageId: id,
  slotKind: z.enum(SLOT_KINDS),
  eventDate: dateField,
  guests: intField(1, MAX_GUESTS),
  items: z.array(addedItem).max(MAX_QUOTE_ITEMS, "tooMany").default([]),
  removedServiceIds: z.array(id).max(MAX_QUOTE_ITEMS, "tooMany").default([]),
  /** Approved discounts only (BR-50), in pounds as typed; empty → 0. */
  discountAmount: z
    .union([z.literal(""), z.null(), nonNegativePoundsField])
    .optional()
    .transform((v) => (typeof v === "number" ? v : 0)),
});

export type QuoteInput = z.output<typeof quoteSchema>;
