/**
 * Package prices and included services (DATA_MODEL §3), checked before saving. Prices are
 * per slot kind and season; `seasonId` null is the regular price (BR-30). The season price
 * itself is resolved by the pricing engine (phase 4).
 */

export const SLOT_KINDS = ["day", "evening", "full_day"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export const PRICING_TYPES = ["fixed", "per_unit", "per_guest"] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

export const SERVICE_CATEGORIES = ["service", "show", "hospitality"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export type PackagePrice = { slotKind: SlotKind; seasonId: string | null; price: number };

export type PriceViolation =
  "priceDuplicate" | "seasonPriceWithoutRegular" | "inactiveSeasonPrice" | "activeWithoutRegularPrice";

const priceKey = (p: Pick<PackagePrice, "slotKind" | "seasonId">) => `${p.slotKind}|${p.seasonId ?? ""}`;

/** D-56: a package is bookable on the slots that have a regular price, in slot order. */
export const bookableSlotKinds = (prices: readonly PackagePrice[]): SlotKind[] =>
  SLOT_KINDS.filter((kind) => prices.some((p) => p.slotKind === kind && p.seasonId === null));

/** The cheapest regular price, for lists; null when the package has none. */
export function lowestRegularPrice(prices: readonly PackagePrice[]): number | null {
  const regular = prices.filter((p) => p.seasonId === null).map((p) => p.price);
  return regular.length > 0 ? Math.min(...regular) : null;
}

/**
 * BR-30 / D-56 / D-78 on a price set about to be saved:
 * - one price per (slot, season);
 * - a season price needs a regular price for the same slot;
 * - an inactive season keeps its existing prices but gets no new or changed ones;
 * - an active package has a regular price for at least one slot (phase 3 acceptance).
 */
export function priceSetViolation(
  prices: readonly PackagePrice[],
  context: {
    active: boolean;
    inactiveSeasonIds: ReadonlySet<string>;
    existing: readonly PackagePrice[];
  },
): PriceViolation | null {
  const keys = new Set<string>();
  for (const p of prices) {
    const key = priceKey(p);
    if (keys.has(key)) return "priceDuplicate";
    keys.add(key);
  }
  const regular = new Set(bookableSlotKinds(prices));
  if (prices.some((p) => p.seasonId !== null && !regular.has(p.slotKind))) return "seasonPriceWithoutRegular";
  const existing = new Map(context.existing.map((p) => [priceKey(p), p.price]));
  const touchesInactive = prices.some(
    (p) => p.seasonId !== null && context.inactiveSeasonIds.has(p.seasonId) && existing.get(priceKey(p)) !== p.price,
  );
  if (touchesInactive) return "inactiveSeasonPrice";
  if (context.active && regular.size === 0) return "activeWithoutRegularPrice";
  return null;
}

export type PackageItem = { serviceId: string; quantity: number; removable: boolean; removalCredit: number };

export type ItemViolation =
  | "itemServiceDuplicate"
  | "itemQuantityFixed"
  | "itemQuantityOutOfRange"
  | "removalCreditNotRemovable"
  | "inactiveServiceAdded";

export const MAX_ITEM_QUANTITY = 10_000;

/**
 * BR-33 / D-79 / D-80 on the included services about to be saved:
 * - a service at most once;
 * - quantity 1–10000 for per-unit services, exactly 1 for fixed and per-guest ones;
 * - a removal credit only on a removable item;
 * - an inactive service stays where it is but is not added anew.
 */
export function itemSetViolation(
  items: readonly PackageItem[],
  context: {
    services: ReadonlyMap<string, { pricingType: PricingType; isActive: boolean }>;
    existingServiceIds: ReadonlySet<string>;
  },
): ItemViolation | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.serviceId)) return "itemServiceDuplicate";
    seen.add(item.serviceId);
    const service = context.services.get(item.serviceId);
    if (!service) continue; // Unknown services are the caller's NOT_FOUND.
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) {
      return "itemQuantityOutOfRange";
    }
    if (service.pricingType !== "per_unit" && item.quantity !== 1) return "itemQuantityFixed";
    if (!item.removable && item.removalCredit !== 0) return "removalCreditNotRemovable";
    if (!service.isActive && !context.existingServiceIds.has(item.serviceId)) return "inactiveServiceAdded";
  }
  return null;
}
