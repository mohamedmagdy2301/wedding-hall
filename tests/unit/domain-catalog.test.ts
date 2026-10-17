import { describe, expect, it } from "vitest";
import {
  bookableSlotKinds,
  itemSetViolation,
  lowestRegularPrice,
  priceSetViolation,
  type PackageItem,
  type PackagePrice,
  type PricingType,
} from "@/domain/catalog";

const SUMMER = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";

const regular = (slotKind: PackagePrice["slotKind"], price = 5_000_000): PackagePrice => ({
  slotKind,
  seasonId: null,
  price,
});
const seasonal = (slotKind: PackagePrice["slotKind"], seasonId = SUMMER, price = 6_000_000): PackagePrice => ({
  slotKind,
  seasonId,
  price,
});

const check = (prices: PackagePrice[], active = true, existing: PackagePrice[] = []) =>
  priceSetViolation(prices, { active, inactiveSeasonIds: new Set([OLD]), existing });

describe("package prices (BR-30, D-56, D-78)", () => {
  it("BR-30: an active package needs a regular price for at least one slot", () => {
    expect(check([])).toBe("activeWithoutRegularPrice");
    expect(check([seasonal("evening")])).not.toBeNull();
    expect(check([regular("evening")])).toBeNull();
  });

  it("D-78: an inactive package (draft) may be saved without prices", () => {
    expect(check([], false)).toBeNull();
  });

  it("D-78: a season price needs a regular price for the same slot", () => {
    expect(check([regular("evening"), seasonal("day")])).toBe("seasonPriceWithoutRegular");
    expect(check([regular("evening"), seasonal("evening")])).toBeNull();
    // Checked on drafts too: the season price would never apply (D-56).
    expect(check([seasonal("day")], false)).toBe("seasonPriceWithoutRegular");
  });

  it("one price per slot and season", () => {
    expect(check([regular("day"), regular("day", 1)])).toBe("priceDuplicate");
    expect(check([regular("day"), seasonal("day"), seasonal("day", SUMMER, 1)])).toBe("priceDuplicate");
    expect(check([regular("day"), regular("evening"), regular("full_day")])).toBeNull();
  });

  it("D-78: an inactive season keeps its prices, but gets no new or changed ones", () => {
    const kept = seasonal("evening", OLD, 7_000_000);
    expect(check([regular("evening"), kept], true, [regular("evening"), kept])).toBeNull();
    expect(check([regular("evening")], true, [regular("evening"), kept])).toBeNull(); // removed
    expect(check([regular("evening"), kept], true, [regular("evening")])).toBe("inactiveSeasonPrice");
    const changed = { ...kept, price: 7_500_000 };
    expect(check([regular("evening"), changed], true, [regular("evening"), kept])).toBe("inactiveSeasonPrice");
  });

  it("D-56: bookable slots are those with a regular price, in slot order", () => {
    expect(bookableSlotKinds([regular("full_day"), seasonal("day"), regular("day")])).toEqual(["day", "full_day"]);
    expect(bookableSlotKinds([seasonal("evening")])).toEqual([]);
  });

  it("lowest regular price ignores season prices", () => {
    expect(lowestRegularPrice([regular("day", 300), regular("evening", 500), seasonal("day", SUMMER, 100)])).toBe(300);
    expect(lowestRegularPrice([])).toBeNull();
  });
});

describe("included services (BR-33, D-79, D-80)", () => {
  const ids = { fixed: "a", perUnit: "b", perGuest: "c", inactive: "d" };
  const services = new Map<string, { pricingType: PricingType; isActive: boolean }>([
    [ids.fixed, { pricingType: "fixed", isActive: true }],
    [ids.perUnit, { pricingType: "per_unit", isActive: true }],
    [ids.perGuest, { pricingType: "per_guest", isActive: true }],
    [ids.inactive, { pricingType: "fixed", isActive: false }],
  ]);
  const item = (serviceId: string, extra: Partial<PackageItem> = {}): PackageItem => ({
    serviceId,
    quantity: 1,
    removable: false,
    removalCredit: 0,
    ...extra,
  });
  const check = (items: PackageItem[], existing: string[] = []) =>
    itemSetViolation(items, { services, existingServiceIds: new Set(existing) });

  it("D-80: a service appears at most once", () => {
    expect(check([item(ids.fixed), item(ids.fixed)])).toBe("itemServiceDuplicate");
  });

  it("D-79: quantity only for per-unit services, within 1–10000", () => {
    expect(check([item(ids.perUnit, { quantity: 4 })])).toBeNull();
    expect(check([item(ids.perUnit, { quantity: 10_001 })])).toBe("itemQuantityOutOfRange");
    expect(check([item(ids.perUnit, { quantity: 0 })])).toBe("itemQuantityOutOfRange");
    expect(check([item(ids.fixed, { quantity: 2 })])).toBe("itemQuantityFixed");
    expect(check([item(ids.perGuest, { quantity: 2 })])).toBe("itemQuantityFixed");
  });

  it("BR-33: a removal credit only on a removable item", () => {
    expect(check([item(ids.fixed, { removalCredit: 20_000 })])).toBe("removalCreditNotRemovable");
    expect(check([item(ids.fixed, { removable: true, removalCredit: 20_000 })])).toBeNull();
    expect(check([item(ids.fixed, { removable: true, removalCredit: 0 })])).toBeNull();
  });

  it("D-80: an inactive service stays in a package but is not added anew", () => {
    expect(check([item(ids.inactive)])).toBe("inactiveServiceAdded");
    expect(check([item(ids.inactive)], [ids.inactive])).toBeNull();
  });
});
