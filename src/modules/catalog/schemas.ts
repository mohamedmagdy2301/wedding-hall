import { z } from "zod";
import { MAX_ITEM_QUANTITY, PRICING_TYPES, SERVICE_CATEGORIES, SLOT_KINDS } from "@/domain/catalog";
import { id, intField, listName, nonNegativePoundsField, optionalText, poundsField } from "@/modules/shared/fields";

// Ranges from D-79. Messages are i18n keys (errors.messages).

export const MAX_BASE_GUESTS = 100_000;
export const MAX_PACKAGE_PRICES = 100;
export const MAX_PACKAGE_ITEMS = 100;

/** Empty text → 0 (an optional amount, such as an external fee or a removal credit). */
const optionalAmount = z
  .union([z.literal(""), z.null(), nonNegativePoundsField])
  .optional()
  .transform((v) => (typeof v === "number" ? v : 0));

const serviceShape = {
  name: listName,
  category: z.enum(SERVICE_CATEGORIES),
  pricingType: z.enum(PRICING_TYPES),
  unitPrice: nonNegativePoundsField,
  allowExternal: z.boolean(),
  externalFee: optionalAmount,
};

/** BR-34 / D-39: the external fee only applies when external providers are allowed. */
const withoutStrayFee = <T extends { allowExternal: boolean; externalFee: number }>(s: T) => ({
  ...s,
  externalFee: s.allowExternal ? s.externalFee : 0,
});

export const createServiceSchema = z.object(serviceShape).transform(withoutStrayFee);
export const updateServiceSchema = z.object({ serviceId: id, ...serviceShape }).transform(withoutStrayFee);
export const setServiceActiveSchema = z.object({ serviceId: id, active: z.boolean() });

const priceSchema = z.object({
  slotKind: z.enum(SLOT_KINDS),
  seasonId: id.nullable(),
  price: poundsField.refine((p) => p > 0, "pricePositive"),
});

/** Removal credit only on removable items (BR-33); a non-removable item carries 0. */
const itemSchema = z
  .object({
    serviceId: id,
    quantity: intField(1, MAX_ITEM_QUANTITY),
    removable: z.boolean(),
    removalCredit: optionalAmount,
  })
  .transform((i) => ({ ...i, removalCredit: i.removable ? i.removalCredit : 0 }));

const packageFields = {
  name: listName,
  description: optionalText(500),
  baseGuests: intField(0, MAX_BASE_GUESTS),
  extraGuestPrice: nonNegativePoundsField,
  isActive: z.boolean(),
  prices: z.array(priceSchema).max(MAX_PACKAGE_PRICES, "tooMany"),
  items: z.array(itemSchema).max(MAX_PACKAGE_ITEMS, "tooMany"),
};

/** The version the edit page was opened on (D-81). */
const version = z.number().int().min(1);

export const createPackageSchema = z.object({ spaceId: id, ...packageFields });
export const updatePackageSchema = z.object({ packageId: id, version, ...packageFields });
export const setPackageActiveSchema = z.object({ packageId: id, version, active: z.boolean() });
