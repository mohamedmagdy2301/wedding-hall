import { MAX_ITEM_QUANTITY, type PackagePrice, type PricingType, type ServiceCategory, type SlotKind } from "./catalog";
import { MAX_PIASTERS } from "./money";
import { seasonForDate } from "./seasons";

/**
 * The pricing engine (BR-30..BR-36): a pure function of the current catalog and a request —
 * no database, no clock, inputs never mutated (CLAUDE.md rule 8). Amounts are integer
 * piasters; the formula has no percentages, so nothing is rounded here (D-96).
 *
 *   base_price + extra_guests_amount + items_total − removal_credits_total = subtotal
 *   subtotal − discount_amount = total,   subtotal ≥ 0 (BR-35),   0 ≤ discount ≤ subtotal (BR-52)
 *
 * The breakdown is what a booking stores (BR-37, D-84, D-85); `summarize` is the one formula
 * every later phase uses to recompute the totals from stored lines.
 */

export const MAX_GUESTS = 100_000;
/** Added items and removed services per request (D-87). */
export const MAX_QUOTE_ITEMS = 100;

/** A service as it is in the catalog now. */
export type PricingService = {
  id: string;
  name: string;
  category: ServiceCategory;
  pricingType: PricingType;
  unitPrice: number;
  allowExternal: boolean;
  externalFee: number;
  isActive: boolean;
};

/** A service included in the package price (BR-33). The removal credit is fixed, even per guest. */
export type IncludedService = {
  service: PricingService;
  quantity: number;
  removable: boolean;
  removalCredit: number;
};

export type PricingSeason = { id: string; startDate: string; endDate: string };

export type PricingCatalog = {
  package: {
    baseGuests: number;
    extraGuestPrice: number;
    /** Every stored price, including those of inactive seasons (ignored, D-78). */
    prices: readonly PackagePrice[];
    /** In package order. */
    included: readonly IncludedService[];
  };
  activeSeasons: readonly PricingSeason[];
  /** The services the request adds, by id. */
  services: ReadonlyMap<string, PricingService>;
};

export type AddedItemRequest = { serviceId: string; quantity: number; isExternal: boolean };

export type QuoteRequest = {
  slotKind: SlotKind;
  /** YYYY-MM-DD: the Cairo date of the party start (BR-31). */
  eventDate: string;
  guests: number;
  added: readonly AddedItemRequest[];
  /** Included services removed from the package (D-86). */
  removedServiceIds: readonly string[];
  /** Approved discounts only (BR-50). */
  discountAmount: number;
};

/** One booking item (D-84). Phase 7 adds `guest_adjustment` lines. */
export type PriceLine = {
  source: "package" | "added";
  serviceId: string;
  name: string;
  category: ServiceCategory;
  pricingType: PricingType;
  /** What the hall charges per unit: 0 when included or external (D-84, D-91). */
  unitPrice: number;
  /** Units; for an added per-guest line, the guests it covers; 1 when fixed; the package quantity when included. */
  quantity: number;
  isExternal: boolean;
  /** Charged once per line, never multiplied (D-39); 0 unless external. */
  externalFee: number;
  isRemoved: boolean;
  /** Copied for included lines; 0 for added ones. */
  removalCredit: number;
  /** Signed: included 0, removed −removalCredit, external externalFee, internal unitPrice (× quantity). */
  lineTotal: number;
};

export type PriceBreakdown = {
  slotKind: SlotKind;
  eventDate: string;
  guests: number;
  /** The season whose price was applied; null with the regular price (D-88). */
  seasonId: string | null;
  /** The active season the date falls in, for display only (D-88). */
  dateSeasonId: string | null;
  basePrice: number;
  baseGuests: number;
  extraGuestPrice: number;
  extraGuests: number;
  extraGuestsAmount: number;
  /** Included lines in package order, then added lines in request order. */
  lines: PriceLine[];
  /** Includes external fees (D-85). */
  itemsTotal: number;
  externalFeesTotal: number;
  removalCreditsTotal: number;
  /** Before the discount (BR-52). */
  subtotal: number;
  discountAmount: number;
  total: number;
};

export type PricingViolation =
  | "guestsInvalid"
  | "discountInvalid"
  | "slotNotPriced" // BR-30, D-56
  | "removedDuplicate"
  | "itemNotIncluded"
  | "itemNotRemovable" // BR-33
  | "addedDuplicate"
  | "serviceUnknown"
  | "serviceInactive" // D-87
  | "alreadyIncluded" // D-90
  | "quantityInvalid"
  | "externalNotAllowed" // BR-34
  | "amountTooLarge"
  | "negativeTotal" // BR-35, D-89
  | "discountExceedsSubtotal"; // BR-52

export type QuoteResult =
  { ok: true; breakdown: PriceBreakdown } | { ok: false; violation: PricingViolation; serviceId?: string };

export type BasePrice = { basePrice: number; seasonId: string | null; dateSeasonId: string | null };

/**
 * BR-30 / BR-31 / D-56 / D-78 / D-88: the package price for the slot in the season of the date
 * if it has one, otherwise the regular price. Null when the slot has no regular price — the
 * package is not bookable on it, whatever its season prices. Also used by postponement (D-94).
 */
export function resolveBasePrice(
  prices: readonly PackagePrice[],
  slotKind: SlotKind,
  eventDate: string,
  activeSeasons: readonly PricingSeason[],
): BasePrice | null {
  const regular = prices.find((p) => p.slotKind === slotKind && p.seasonId === null);
  if (!regular) return null;
  const season = seasonForDate(activeSeasons, eventDate);
  const seasonal = season && prices.find((p) => p.slotKind === slotKind && p.seasonId === season.id);
  const dateSeasonId = season?.id ?? null;
  return seasonal
    ? { basePrice: seasonal.price, seasonId: season.id, dateSeasonId }
    : { basePrice: regular.price, seasonId: null, dateSeasonId };
}

export type Totals = Pick<
  PriceBreakdown,
  "itemsTotal" | "externalFeesTotal" | "removalCreditsTotal" | "subtotal" | "total"
>;

/** What `summarize` reads of a line: the engine's, or a stored one with its `guest_adjustment` lines (D-92). */
export type SummedLine = Pick<PriceLine, "isRemoved" | "removalCredit" | "isExternal" | "externalFee" | "lineTotal"> & {
  source: PriceLine["source"] | "guest_adjustment";
};

/** BR-32 over stored parts (D-84, D-85): the only place the totals are added up. */
export function summarize(parts: {
  basePrice: number;
  extraGuestsAmount: number;
  lines: readonly SummedLine[];
  discountAmount: number;
}): Totals {
  let itemsTotal = 0;
  let externalFeesTotal = 0;
  let removalCreditsTotal = 0;
  for (const line of parts.lines) {
    if (line.isRemoved) removalCreditsTotal += line.removalCredit;
    if (line.source === "package") continue;
    itemsTotal += line.lineTotal;
    if (line.isExternal) externalFeesTotal += line.externalFee;
  }
  const subtotal = parts.basePrice + parts.extraGuestsAmount + itemsTotal - removalCreditsTotal;
  return { itemsTotal, externalFeesTotal, removalCreditsTotal, subtotal, total: subtotal - parts.discountAmount };
}

const fail = (violation: PricingViolation, serviceId?: string): QuoteResult =>
  serviceId === undefined ? { ok: false, violation } : { ok: false, violation, serviceId };

const isAmount = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_PIASTERS;

/** The first item (in request order) failing a check, so the reported violation never depends on item order. */
const firstFailing = <T>(items: readonly T[], failing: (item: T) => boolean) => items.find(failing);

/**
 * Prices a request against the current catalog. Checks run in a fixed order — guests and
 * discount, slot price, removed services, added services, amounts, BR-35, BR-52 — and the
 * first violation is returned (P4-01). Each check covers every item before the next one.
 */
export function quotePrice(catalog: PricingCatalog, request: QuoteRequest): QuoteResult {
  const { guests, discountAmount } = request;
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) return fail("guestsInvalid");
  if (!isAmount(discountAmount)) return fail("discountInvalid");

  const base = resolveBasePrice(catalog.package.prices, request.slotKind, request.eventDate, catalog.activeSeasons);
  if (!base) return fail("slotNotPriced");

  // Removed included services (BR-33).
  const included = new Map(catalog.package.included.map((i) => [i.service.id, i]));
  const removed = new Set<string>();
  const duplicateRemoved = firstFailing(request.removedServiceIds, (id) => removed.size === removed.add(id).size);
  if (duplicateRemoved !== undefined) return fail("removedDuplicate", duplicateRemoved);
  const notIncluded = firstFailing(request.removedServiceIds, (id) => !included.has(id));
  if (notIncluded !== undefined) return fail("itemNotIncluded", notIncluded);
  const notRemovable = firstFailing(request.removedServiceIds, (id) => !included.get(id)!.removable);
  if (notRemovable !== undefined) return fail("itemNotRemovable", notRemovable);

  // Added services (BR-34, D-87, D-90).
  const added = request.added;
  const seen = new Set<string>();
  const checks: [PricingViolation, (item: AddedItemRequest) => boolean][] = [
    ["addedDuplicate", (item) => seen.size === seen.add(item.serviceId).size],
    ["serviceUnknown", (item) => !catalog.services.has(item.serviceId)],
    ["serviceInactive", (item) => !catalog.services.get(item.serviceId)!.isActive],
    [
      "alreadyIncluded",
      (item) => {
        if (!included.has(item.serviceId)) return false;
        // Removed: only an external provider may replace it. Kept: only extra units of a per-unit service.
        if (removed.has(item.serviceId)) return !item.isExternal;
        return catalog.services.get(item.serviceId)!.pricingType !== "per_unit";
      },
    ],
    [
      "quantityInvalid",
      (item) => {
        const perUnit = catalog.services.get(item.serviceId)!.pricingType === "per_unit";
        const q = item.quantity;
        return !Number.isInteger(q) || (perUnit ? q < 1 || q > MAX_ITEM_QUANTITY : q !== 1);
      },
    ],
    ["externalNotAllowed", (item) => item.isExternal && !catalog.services.get(item.serviceId)!.allowExternal],
  ];
  for (const [violation, failing] of checks) {
    const item = firstFailing(added, failing);
    if (item) return fail(violation, item.serviceId);
  }

  const lines: PriceLine[] = [];
  for (const inc of catalog.package.included) {
    const isRemoved = removed.has(inc.service.id);
    lines.push({
      source: "package",
      serviceId: inc.service.id,
      name: inc.service.name,
      category: inc.service.category,
      pricingType: inc.service.pricingType,
      unitPrice: 0,
      quantity: inc.quantity,
      isExternal: false,
      externalFee: 0,
      isRemoved,
      removalCredit: inc.removalCredit,
      lineTotal: isRemoved ? -inc.removalCredit : 0,
    });
  }
  for (const item of added) {
    const service = catalog.services.get(item.serviceId)!;
    const common = {
      source: "added" as const,
      serviceId: service.id,
      name: service.name,
      category: service.category,
      pricingType: service.pricingType,
      isRemoved: false,
      removalCredit: 0,
    };
    if (item.isExternal) {
      // D-91: the customer pays the provider directly; the hall charges the entry fee once (D-39).
      lines.push({
        ...common,
        unitPrice: 0,
        quantity: item.quantity,
        isExternal: true,
        externalFee: service.externalFee,
        lineTotal: service.externalFee,
      });
    } else {
      // D-84: a per-guest line covers the guests it was priced for.
      const quantity = service.pricingType === "per_guest" ? guests : item.quantity;
      const lineTotal = service.pricingType === "fixed" ? service.unitPrice : service.unitPrice * quantity;
      lines.push({ ...common, unitPrice: service.unitPrice, quantity, isExternal: false, externalFee: 0, lineTotal });
    }
  }

  const { baseGuests, extraGuestPrice } = catalog.package;
  const extraGuests = Math.max(0, guests - baseGuests);
  const extraGuestsAmount = extraGuests * extraGuestPrice;
  // Products of safe integers that exceed the cap stay above it even when inexact.
  const charged = [base.basePrice, extraGuestsAmount, ...lines.map((l) => Math.abs(l.lineTotal))];
  if (charged.some((amount) => !(amount <= MAX_PIASTERS))) return fail("amountTooLarge");

  const totals = summarize({ basePrice: base.basePrice, extraGuestsAmount, lines, discountAmount });
  if (base.basePrice + extraGuestsAmount + totals.itemsTotal > MAX_PIASTERS) return fail("amountTooLarge");
  if (totals.subtotal < 0) return fail("negativeTotal");
  if (discountAmount > totals.subtotal) return fail("discountExceedsSubtotal");

  return {
    ok: true,
    breakdown: {
      slotKind: request.slotKind,
      eventDate: request.eventDate,
      guests,
      seasonId: base.seasonId,
      dateSeasonId: base.dateSeasonId,
      basePrice: base.basePrice,
      baseGuests,
      extraGuestPrice,
      extraGuests,
      extraGuestsAmount,
      lines,
      ...totals,
      discountAmount,
    },
  };
}
