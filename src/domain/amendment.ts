import { MAX_ITEM_QUANTITY, type PricingType, type ServiceCategory } from "./catalog";
import { MAX_PIASTERS } from "./money";
import { MAX_GUESTS, summarize, type PricingService, type Totals } from "./pricing";

/**
 * Changing a confirmed booking's lines and guests (BR-40..43, D-35, D-92, D-93, D-128):
 * a pure function of the stored lines, the price snapshot and the current catalog — no
 * database, no clock (CLAUDE.md rule 8). Nothing is recomputed from scratch: lines are
 * voided, replaced or added, and the totals come from `summarize` (D-85, D-96).
 *
 * Per-guest money is a stack of guest ranges. The extra-guest charge covers
 * [base_guests, max(guests, base_guests)): first the snapshot (`extra_guests_amount` at the
 * fixed `extra_guest_price`), then one `guest_adjustment` line per increase at the price
 * then. Each per-guest added service covers [0, guests) the same way: its confirmed line,
 * then a line per increase. An increase stacks a line on top at the current price (D-92); a
 * decrease cuts from the top, so it cancels the newest increases first at their prices and
 * only then the confirmed lines at the fixed ones (D-93). Ranges are not stored: each
 * stack's top is the guests count, and its lines are in the order they were added.
 *
 * Prices typed by hand go on new lines only (Q7-05): above the current price they apply;
 * below it the line keeps the current price and the difference becomes a discount request.
 */

export type StoredLine = {
  id: string;
  /** Null only for the extra-guest lines. */
  serviceId: string | null;
  name: string;
  category: ServiceCategory;
  pricingType: PricingType;
  unitPrice: number;
  quantity: number;
  source: "package" | "added" | "guest_adjustment";
  isRemoved: boolean;
  removalCredit: number;
  isExternal: boolean;
  externalFee: number;
  lineTotal: number;
};

export type NewLine = Omit<StoredLine, "id">;

/** The confirmed snapshot's fixed parts (BR-37) and the guests now. */
export type AmendSnapshot = {
  guests: number;
  baseGuests: number;
  /** Fixed at confirmation; refunds of the snapshot's extra guests use it. */
  extraGuestPrice: number;
  basePrice: number;
  extraGuestsAmount: number;
  /** Approved discounts (BR-50). */
  discountAmount: number;
};

export type AmendCatalog = {
  /** The package's extra-guest price now (D-92: even if the package is inactive). */
  extraGuestPrice: number;
  /** Services of the venue now, by id. */
  services: ReadonlyMap<string, PricingService>;
  /** The package's included services now and whether each may be removed (BR-33). */
  removable: ReadonlyMap<string, boolean>;
};

export type AmendRequest = {
  guests: number;
  /** A price typed for the new extra-guest line; null = the current one. */
  extraGuestUnitPrice: number | null;
  /** Prices typed for the new per-guest lines of an increase, by service. */
  guestServicePrices: ReadonlyMap<string, number>;
  add: readonly { serviceId: string; quantity: number; isExternal: boolean; unitPrice: number | null }[];
  /** Added services taken off entirely (all their lines). */
  remove: readonly string[];
  /** New quantity of an added internal per-unit service. */
  quantities: readonly { serviceId: string; quantity: number; unitPrice: number | null }[];
  removeIncluded: readonly string[];
  restoreIncluded: readonly string[];
};

export type OverrideDiscount = { serviceId: string | null; name: string; amount: number };
export type PriceOverride = { serviceId: string | null; name: string; currentPrice: number; typedPrice: number };

export type Amendment = {
  guests: number;
  extraGuestsAmount: number;
  voidLineIds: string[];
  newLines: NewLine[];
  /** Included lines removed or restored: their new state. */
  includedChanges: { lineId: string; isRemoved: boolean; lineTotal: number }[];
  /** Prices typed below the current one: the differences, to become discount requests (BR-41). */
  overrideDiscounts: OverrideDiscount[];
  /** Prices typed above the current one, applied as typed. */
  overrides: PriceOverride[];
  totals: Totals;
  changed: boolean;
};

export type AmendViolation =
  | "guestsInvalid"
  | "changeDuplicate"
  | "lineNotFound"
  | "serviceUnknown"
  | "serviceInactive" // D-87
  | "addedDuplicate" // D-90: a service once among the added lines
  | "alreadyIncluded" // D-90
  | "quantityInvalid"
  | "quantityNotAdjustable"
  | "externalNotAllowed" // BR-34
  | "itemNotIncluded"
  | "itemNotRemovable" // BR-33
  | "includedAlreadyRemoved"
  | "includedNotRemoved"
  | "includedHasAddedUnits" // D-90: a removed included service comes back as external only
  | "priceInvalid"
  | "amountTooLarge"
  | "negativeTotal" // BR-35
  | "discountExceedsSubtotal"; // BR-52

export type AmendResult =
  { ok: true; amendment: Amendment } | { ok: false; violation: AmendViolation; serviceId?: string };

const fail = (violation: AmendViolation, serviceId?: string): AmendResult =>
  serviceId === undefined ? { ok: false, violation } : { ok: false, violation, serviceId };

const isAmount = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_PIASTERS;

const lineTotalOf = (line: Pick<NewLine, "pricingType" | "unitPrice" | "quantity" | "isExternal" | "externalFee">) =>
  line.isExternal ? line.externalFee : line.pricingType === "fixed" ? line.unitPrice : line.unitPrice * line.quantity;

/** A charged line of an added service (or of the extra guests: `serviceId` null). */
const isCharged = (l: StoredLine) => l.source !== "package";

/**
 * The extra-guest line name comes from the caller (it is stored and printed in Arabic, D-128);
 * everything else is the catalog's.
 */
export function amendBooking(
  lines: readonly StoredLine[],
  snapshot: AmendSnapshot,
  catalog: AmendCatalog,
  request: AmendRequest,
  extraGuestsLineName: string,
): AmendResult {
  const { guests } = request;
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) return fail("guestsInvalid");

  // A service in one change of its added lines and one of its included line, at most: removing
  // the included DJ and adding an external one is one change (D-90).
  for (const ids of [
    [...request.add.map((a) => a.serviceId), ...request.remove, ...request.quantities.map((q) => q.serviceId)],
    [...request.removeIncluded, ...request.restoreIncluded],
  ]) {
    const seen = new Set<string>();
    const duplicate = ids.find((id) => seen.size === seen.add(id).size);
    if (duplicate !== undefined) return fail("changeDuplicate", duplicate);
  }
  const typed = [
    request.extraGuestUnitPrice,
    ...request.guestServicePrices.values(),
    ...request.add.map((a) => a.unitPrice),
    ...request.quantities.map((q) => q.unitPrice),
  ];
  if (typed.some((price) => price !== null && !isAmount(price))) return fail("priceInvalid");

  const active = new Map(lines.map((l) => [l.id, l]));
  const voidIds: string[] = [];
  const newLines: NewLine[] = [];
  const includedChanges: Amendment["includedChanges"] = [];
  const overrideDiscounts: OverrideDiscount[] = [];
  const overrides: PriceOverride[] = [];
  let extraGuestsAmount = snapshot.extraGuestsAmount;

  /** The service's charged lines, active and new, oldest first. */
  const stackOf = (serviceId: string | null) => [
    ...[...active.values()].filter((l) => isCharged(l) && l.serviceId === serviceId),
    ...newLines.filter((l) => l.source !== "package" && l.serviceId === serviceId),
  ];
  const dropLine = (line: StoredLine | NewLine) => {
    if ("id" in line) {
      active.delete(line.id);
      voidIds.push(line.id);
    } else {
      newLines.splice(newLines.indexOf(line), 1);
    }
  };

  /** Cuts `count` units off the top of a stack; what the lines did not cover is returned. */
  const cut = (stack: (StoredLine | NewLine)[], count: number) => {
    let left = count;
    for (const line of [...stack].reverse()) {
      if (left === 0) break;
      dropLine(line);
      if (line.quantity <= left) {
        left -= line.quantity;
      } else {
        const kept = { ...line, quantity: line.quantity - left };
        delete (kept as Partial<StoredLine>).id;
        newLines.push({ ...(kept as NewLine), lineTotal: lineTotalOf(kept) });
        left = 0;
      }
    }
    return left;
  };

  /** A new line at the current price, or a typed one (Q7-05). */
  const priced = (
    base: Omit<NewLine, "unitPrice" | "lineTotal">,
    currentPrice: number,
    typedPrice: number | null,
  ): NewLine => {
    const unitPrice = typedPrice !== null && typedPrice > currentPrice ? typedPrice : currentPrice;
    const line = { ...base, unitPrice, lineTotal: 0 };
    line.lineTotal = lineTotalOf(line);
    if (typedPrice !== null && typedPrice > currentPrice) {
      overrides.push({ serviceId: base.serviceId, name: base.name, currentPrice, typedPrice });
    } else if (typedPrice !== null && typedPrice < currentPrice) {
      const amount = lineTotalOf({ ...line, unitPrice: currentPrice - typedPrice });
      if (amount > 0) overrideDiscounts.push({ serviceId: base.serviceId, name: base.name, amount });
    }
    return line;
  };

  const addedLine = (service: PricingService, quantity: number, source: NewLine["source"]) => ({
    serviceId: service.id,
    name: service.name,
    category: service.category,
    pricingType: service.pricingType,
    quantity,
    source,
    isRemoved: false,
    removalCredit: 0,
    isExternal: false,
    externalFee: 0,
  });

  const includedLine = (serviceId: string) =>
    [...active.values()].find((l) => l.source === "package" && l.serviceId === serviceId);
  const addedLines = (serviceId: string) => stackOf(serviceId);

  // 1. Added services taken off: every line, at its own price (BR-43).
  for (const serviceId of request.remove) {
    const own = addedLines(serviceId);
    if (own.length === 0) return fail("lineNotFound", serviceId);
    own.forEach(dropLine);
  }

  // 2. Included services removed (at the credit fixed on the line) or restored (BR-33, BR-43).
  for (const serviceId of request.removeIncluded) {
    const line = includedLine(serviceId);
    if (!line) return fail("itemNotIncluded", serviceId);
    if (line.isRemoved) return fail("includedAlreadyRemoved", serviceId);
    if (!catalog.removable.get(serviceId)) return fail("itemNotRemovable", serviceId);
    if (addedLines(serviceId).some((l) => !l.isExternal)) return fail("includedHasAddedUnits", serviceId);
    includedChanges.push({ lineId: line.id, isRemoved: true, lineTotal: -line.removalCredit });
  }
  for (const serviceId of request.restoreIncluded) {
    const line = includedLine(serviceId);
    if (!line) return fail("itemNotIncluded", serviceId);
    if (!line.isRemoved) return fail("includedNotRemoved", serviceId);
    // Its external replacement goes first (D-90).
    if (addedLines(serviceId).length > 0) return fail("alreadyIncluded", serviceId);
    includedChanges.push({ lineId: line.id, isRemoved: false, lineTotal: 0 });
  }
  const removedNow = (serviceId: string) => {
    const change = includedChanges.find((c) => includedLine(serviceId)?.id === c.lineId);
    return change ? change.isRemoved : (includedLine(serviceId)?.isRemoved ?? false);
  };

  // 3. Quantities of added internal per-unit services: more units at the current price (BR-40),
  // fewer cut from the newest lines (BR-43).
  for (const change of request.quantities) {
    const own = addedLines(change.serviceId);
    if (own.length === 0) return fail("lineNotFound", change.serviceId);
    if (own.some((l) => l.isExternal || l.pricingType !== "per_unit")) {
      return fail("quantityNotAdjustable", change.serviceId);
    }
    const q = change.quantity;
    if (!Number.isInteger(q) || q < 1 || q > MAX_ITEM_QUANTITY) return fail("quantityInvalid", change.serviceId);
    const current = own.reduce((sum, l) => sum + l.quantity, 0);
    if (q < current) {
      cut(own, current - q);
    } else if (q > current) {
      const service = catalog.services.get(change.serviceId);
      if (!service) return fail("serviceUnknown", change.serviceId);
      newLines.push(priced(addedLine(service, q - current, "added"), service.unitPrice, change.unitPrice));
    }
  }

  // 4. Guests (D-35, D-92, D-93).
  const before = snapshot.guests;
  const extraTop = (g: number) => Math.max(g, snapshot.baseGuests);
  const perGuestServices = [
    ...new Set(
      [...active.values()]
        .filter((l) => isCharged(l) && l.serviceId !== null && l.pricingType === "per_guest" && !l.isExternal)
        .map((l) => l.serviceId!),
    ),
  ];
  if (guests < before) {
    const extraCut = extraTop(before) - extraTop(guests);
    const left = cut(stackOf(null), extraCut);
    // What the adjustment lines did not cover comes off the snapshot at its fixed price.
    extraGuestsAmount -= left * snapshot.extraGuestPrice;
    for (const serviceId of perGuestServices) cut(stackOf(serviceId), before - guests);
  } else if (guests > before) {
    const extraAdded = extraTop(guests) - extraTop(before);
    if (extraAdded > 0) {
      newLines.push(
        priced(
          {
            serviceId: null,
            name: extraGuestsLineName,
            category: "service",
            pricingType: "per_guest",
            quantity: extraAdded,
            source: "guest_adjustment",
            isRemoved: false,
            removalCredit: 0,
            isExternal: false,
            externalFee: 0,
          },
          catalog.extraGuestPrice,
          request.extraGuestUnitPrice,
        ),
      );
    }
    for (const serviceId of perGuestServices) {
      const service = catalog.services.get(serviceId);
      if (!service) return fail("serviceUnknown", serviceId);
      newLines.push(
        priced(
          addedLine(service, guests - before, "guest_adjustment"),
          service.unitPrice,
          request.guestServicePrices.get(serviceId) ?? null,
        ),
      );
    }
  }

  // 5. New services, at the current price (BR-40), with the engine's rules (BR-34, D-87, D-90).
  for (const item of request.add) {
    const service = catalog.services.get(item.serviceId);
    if (!service) return fail("serviceUnknown", item.serviceId);
    if (!service.isActive) return fail("serviceInactive", item.serviceId);
    if (addedLines(item.serviceId).length > 0) return fail("addedDuplicate", item.serviceId);
    const included = includedLine(item.serviceId);
    if (included) {
      if (removedNow(item.serviceId) ? !item.isExternal : service.pricingType !== "per_unit") {
        return fail("alreadyIncluded", item.serviceId);
      }
    }
    const perUnit = service.pricingType === "per_unit";
    const q = item.quantity;
    if (!Number.isInteger(q) || (perUnit ? q < 1 || q > MAX_ITEM_QUANTITY : q !== 1)) {
      return fail("quantityInvalid", item.serviceId);
    }
    if (item.isExternal) {
      if (!service.allowExternal) return fail("externalNotAllowed", item.serviceId);
      // D-91: the entry fee once; nothing typed by hand.
      newLines.push({
        ...addedLine(service, q, "added"),
        unitPrice: 0,
        isExternal: true,
        externalFee: service.externalFee,
        lineTotal: service.externalFee,
      });
    } else {
      const quantity = service.pricingType === "per_guest" ? guests : q;
      newLines.push(priced(addedLine(service, quantity, "added"), service.unitPrice, item.unitPrice));
    }
  }

  const finalLines = [
    ...[...active.values()].map((l) => {
      const change = includedChanges.find((c) => c.lineId === l.id);
      return change ? { ...l, isRemoved: change.isRemoved, lineTotal: change.lineTotal } : l;
    }),
    ...newLines,
  ];
  if (finalLines.some((l) => !(Math.abs(l.lineTotal) <= MAX_PIASTERS))) return fail("amountTooLarge");
  const totals = summarize({
    basePrice: snapshot.basePrice,
    extraGuestsAmount,
    lines: finalLines,
    discountAmount: snapshot.discountAmount,
  });
  if (snapshot.basePrice + extraGuestsAmount + totals.itemsTotal > MAX_PIASTERS) return fail("amountTooLarge");
  if (totals.subtotal < 0) return fail("negativeTotal");
  if (snapshot.discountAmount > totals.subtotal) return fail("discountExceedsSubtotal");

  return {
    ok: true,
    amendment: {
      guests,
      extraGuestsAmount,
      voidLineIds: voidIds,
      newLines,
      includedChanges,
      overrideDiscounts,
      overrides,
      totals,
      changed: guests !== before || voidIds.length > 0 || newLines.length > 0 || includedChanges.length > 0,
    },
  };
}
