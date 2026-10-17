import { describe, expect, it } from "vitest";
import {
  quotePrice,
  summarize,
  type AddedItemRequest,
  type PriceBreakdown,
  type PricingCatalog,
  type QuoteRequest,
} from "@/domain/pricing";
import { catalogFor, DEFAULT_REQUEST, PACKAGES, S, SUMMER } from "./fixtures/pricing-catalog";

/**
 * PHASE4_PLAN §6.2: PR-01..PR-55. Expected numbers are hand-computed constants (piasters);
 * the comments show the arithmetic. Defaults: GOLD, evening, 2027-01-15, 200 guests.
 */

const GOLD = catalogFor(PACKAGES.GOLD);
const RENT = catalogFor(PACKAGES.RENT);
const ROOF = catalogFor(PACKAGES.ROOF);

const quote = (overrides: Partial<QuoteRequest> = {}, catalog: PricingCatalog = GOLD) =>
  quotePrice(catalog, { ...DEFAULT_REQUEST, ...overrides });

function priced(overrides: Partial<QuoteRequest> = {}, catalog: PricingCatalog = GOLD): PriceBreakdown {
  const result = quote(overrides, catalog);
  if (!result.ok) throw new Error(`expected a price, got ${result.violation}`);
  return result.breakdown;
}

const total = (overrides: Partial<QuoteRequest> = {}, catalog: PricingCatalog = GOLD) =>
  priced(overrides, catalog).total;

const add = (serviceId: string, quantity = 1, isExternal = false): AddedItemRequest => ({
  serviceId,
  quantity,
  isExternal,
});

const line = (b: PriceBreakdown, serviceId: string, source: "package" | "added" = "added") =>
  b.lines.find((l) => l.serviceId === serviceId && l.source === source);

describe("pricing: base price and seasons (BR-30, BR-31, D-56, D-78, D-88)", () => {
  it("PR-01: the regular evening price, with the included services at 0", () => {
    const b = priced();
    expect(b).toMatchObject({ basePrice: 6_000_000, seasonId: null, dateSeasonId: null, total: 6_000_000 });
    expect(b.lines.map((l) => [l.serviceId, l.source, l.lineTotal])).toEqual([
      ["DJ", "package", 0],
      ["PHOTO", "package", 0],
      ["ZAFFA", "package", 0],
      ["WELCOME", "package", 0],
    ]);
  });

  it("PR-02 / PR-03: every slot kind has its own regular price", () => {
    expect(total({ slotKind: "day" })).toBe(4_000_000);
    expect(total({ slotKind: "full_day" })).toBe(9_000_000);
  });

  it("PR-04 / PR-05: a date in the summer uses the summer price", () => {
    expect(priced({ eventDate: "2027-07-10" })).toMatchObject({ basePrice: 7_500_000, seasonId: SUMMER.id });
    expect(priced({ eventDate: "2027-07-10", slotKind: "full_day" })).toMatchObject({
      total: 11_000_000,
      seasonId: SUMMER.id,
    });
  });

  it("PR-06: no summer price for the day slot → the regular price, and the season only for display (D-88)", () => {
    expect(priced({ eventDate: "2027-07-10", slotKind: "day" })).toMatchObject({
      total: 4_000_000,
      seasonId: null,
      dateSeasonId: SUMMER.id,
    });
  });

  it("PR-07: an inactive season's prices are ignored (D-78)", () => {
    expect(priced({ eventDate: "2027-03-12" })).toMatchObject({ total: 6_000_000, seasonId: null, dateSeasonId: null });
  });

  it.each([
    ["2027-06-01", 7_500_000],
    ["2027-09-30", 7_500_000],
    ["2027-05-31", 6_000_000],
    ["2027-10-01", 6_000_000],
  ])("PR-08: season bounds are inclusive — %s costs %i", (eventDate, expected) => {
    expect(total({ eventDate })).toBe(expected);
  });

  it("PR-09: RENT has no regular day or full-day price → not bookable on them (BR-30)", () => {
    expect(quote({ slotKind: "day" }, RENT)).toEqual({ ok: false, violation: "slotNotPriced" });
    expect(quote({ slotKind: "full_day" }, RENT)).toEqual({ ok: false, violation: "slotNotPriced" });
  });

  it("PR-10: a season price without a regular price is never bookable, even in the season (D-56)", () => {
    const seasonOnly = catalogFor({
      ...PACKAGES.RENT,
      prices: [{ slotKind: "evening", seasonId: SUMMER.id, price: 3_000_000 }],
    });
    expect(quote({ eventDate: "2027-07-10" }, seasonOnly)).toEqual({ ok: false, violation: "slotNotPriced" });
  });
});

describe("pricing: guests (BR-32, D-11)", () => {
  it("PR-11: fewer guests than the base pay no extra", () => {
    expect(priced({ guests: 150 })).toMatchObject({ extraGuests: 0, extraGuestsAmount: 0, total: 6_000_000 });
  });

  it("exactly the base: no extra", () => {
    expect(priced({ guests: 200 })).toMatchObject({ extraGuests: 0, total: 6_000_000 });
  });

  it("PR-12: one guest over the base", () => {
    expect(priced({ guests: 201 })).toMatchObject({ extraGuests: 1, extraGuestsAmount: 15_000, total: 6_015_000 });
  });

  it("PR-13: 150 extra × 15,000", () => {
    expect(priced({ guests: 350 })).toMatchObject({ extraGuestsAmount: 2_250_000, total: 8_250_000 });
  });

  it("PR-14: the season price with extra guests: 7,500,000 + 60 × 15,000", () => {
    expect(total({ eventDate: "2027-07-10", guests: 260 })).toBe(8_400_000);
  });

  it("PR-15 / PR-16: a zero base charges every guest", () => {
    expect(total({ guests: 120 }, RENT)).toBe(5_000_000); // 2,000,000 + 120 × 25,000
    expect(total({ guests: 1 }, RENT)).toBe(2_025_000);
  });
});

describe("pricing: added services by pricing type (BR-32, D-12, D-84)", () => {
  it("PR-17: fixed", () => {
    expect(priced({ added: [add("FIRE")] })).toMatchObject({ itemsTotal: 200_000, total: 6_200_000 });
  });

  it("PR-18: per unit, 3 × 400,000", () => {
    expect(total({ added: [add("BAND", 3)] })).toBe(7_200_000);
  });

  it("PR-19: per guest covers every guest, and keeps the count as its quantity (D-84)", () => {
    const b = priced({ guests: 230, added: [add("BUFFET")] });
    expect(line(b, "BUFFET")).toMatchObject({ unitPrice: 18_000, quantity: 230, lineTotal: 4_140_000 });
    expect(b).toMatchObject({ extraGuestsAmount: 450_000, total: 10_590_000 });
  });

  it("PR-20: piasters stay exact: 333 × 1,275 = 424,575", () => {
    const b = priced({ guests: 333, added: [add("JUICE")] });
    expect(b).toMatchObject({ extraGuestsAmount: 1_995_000, itemsTotal: 424_575, total: 8_419_575 });
  });

  it("PR-21: the three types together", () => {
    const b = priced({ guests: 230, added: [add("FIRE"), add("BAND", 3), add("BUFFET")] });
    expect(b).toMatchObject({ itemsTotal: 5_540_000, total: 11_990_000 });
  });

  it("PR-22: extra units of an included per-unit service (D-90)", () => {
    expect(total({ added: [add("PHOTO", 1)] })).toBe(6_250_000);
  });
});

describe("pricing: external providers (BR-34, D-39, D-91)", () => {
  it("PR-23: only the entry fee, once; the service price is not charged", () => {
    const b = priced({ added: [add("BAND", 2, true)] });
    expect(line(b, "BAND")).toMatchObject({ unitPrice: 0, quantity: 2, externalFee: 150_000, lineTotal: 150_000 });
    expect(b).toMatchObject({ itemsTotal: 150_000, externalFeesTotal: 150_000, total: 6_150_000 });
  });

  it("PR-24: the fee is not multiplied by the quantity", () => {
    expect(total({ added: [add("BAND", 5, true)] })).toBe(6_150_000);
  });

  it("PR-25: an external provider without a fee adds nothing", () => {
    const b = priced({ guests: 100, added: [add("PHOTO", 1, true)] }, RENT);
    expect(line(b, "PHOTO")).toMatchObject({ isExternal: true, lineTotal: 0 });
    expect(b.total).toBe(4_500_000); // 2,000,000 + 100 × 25,000
  });

  it("PR-26: internal and external together; the fees are part of items_total (D-85)", () => {
    const b = priced({ added: [add("FIRE"), add("BAND", 2, true)] });
    expect(b).toMatchObject({ itemsTotal: 350_000, externalFeesTotal: 150_000, total: 6_350_000 });
  });

  it("PR-27: a service that does not allow external providers", () => {
    expect(quote({ added: [add("BUFFET", 1, true)] })).toEqual({
      ok: false,
      violation: "externalNotAllowed",
      serviceId: "BUFFET",
    });
  });
});

describe("pricing: removing included services (BR-33, D-14, D-90)", () => {
  it("PR-28: a removable service deducts its credit", () => {
    const b = priced({ removedServiceIds: ["DJ"] });
    expect(line(b, "DJ", "package")).toMatchObject({ isRemoved: true, removalCredit: 300_000, lineTotal: -300_000 });
    expect(b).toMatchObject({ removalCreditsTotal: 300_000, total: 5_700_000 });
  });

  it("PR-29: a non-removable service", () => {
    expect(quote({ removedServiceIds: ["ZAFFA"] })).toEqual({
      ok: false,
      violation: "itemNotRemovable",
      serviceId: "ZAFFA",
    });
  });

  it("PR-30: the credit of a per-guest service is fixed: 6,000,000 + 300 × 15,000 − 400,000", () => {
    expect(total({ guests: 500, removedServiceIds: ["WELCOME"] })).toBe(10_100_000);
  });

  it("PR-31: several removals: 300,000 + 200,000 + 400,000", () => {
    expect(priced({ removedServiceIds: ["DJ", "PHOTO", "WELCOME"] })).toMatchObject({
      removalCreditsTotal: 900_000,
      total: 5_100_000,
    });
  });

  it("PR-32: a service not in the package", () => {
    expect(quote({ removedServiceIds: ["FIRE"] })).toEqual({
      ok: false,
      violation: "itemNotIncluded",
      serviceId: "FIRE",
    });
  });

  it("PR-33: the same service twice", () => {
    expect(quote({ removedServiceIds: ["DJ", "DJ"] })).toEqual({
      ok: false,
      violation: "removedDuplicate",
      serviceId: "DJ",
    });
  });

  it("PR-34: the hall's DJ removed and an external DJ brought: 6,000,000 − 300,000 + 100,000", () => {
    const b = priced({ removedServiceIds: ["DJ"], added: [add("DJ", 1, true)] });
    expect(b.total).toBe(5_800_000);
    expect(line(b, "DJ", "added")).toMatchObject({ isExternal: true, lineTotal: 100_000 });
  });

  it("PR-35: an included fixed service cannot be added again", () => {
    expect(quote({ added: [add("DJ")] })).toEqual({ ok: false, violation: "alreadyIncluded", serviceId: "DJ" });
  });

  it("PR-36: a removed service comes back only as external", () => {
    expect(quote({ removedServiceIds: ["DJ"], added: [add("DJ")] })).toEqual({
      ok: false,
      violation: "alreadyIncluded",
      serviceId: "DJ",
    });
  });

  it("PR-37: an extra external photographer on top of the included ones (fee 0)", () => {
    expect(total({ added: [add("PHOTO", 1, true)] })).toBe(6_000_000);
  });
});

describe("pricing: discount (BR-50..BR-52)", () => {
  const withFire = { added: [add("FIRE")] };

  it("PR-38: the approved discount is deducted from the subtotal", () => {
    expect(priced({ ...withFire, discountAmount: 500_000 })).toMatchObject({ subtotal: 6_200_000, total: 5_700_000 });
  });

  it("PR-39: a discount equal to the subtotal leaves 0", () => {
    expect(total({ ...withFire, discountAmount: 6_200_000 })).toBe(0);
  });

  it("PR-40: a discount above the subtotal (BR-52)", () => {
    expect(quote({ ...withFire, discountAmount: 6_200_001 })).toEqual({
      ok: false,
      violation: "discountExceedsSubtotal",
    });
  });

  it("PR-41: a zero discount", () => {
    expect(total({ ...withFire, discountAmount: 0 })).toBe(6_200_000);
  });
});

describe("pricing: never negative (BR-35, D-89)", () => {
  const roof = (guests: number, overrides: Partial<QuoteRequest> = {}) =>
    quote({ slotKind: "day", guests, ...overrides }, ROOF);
  const both = ["DJ", "DECOR"];

  it("PR-42: ROOF day", () => {
    expect(roof(50)).toMatchObject({ ok: true, breakdown: { total: 1_000_000 } });
  });

  it("PR-43: credits above the price: 1,000,000 − 1,100,000 → refused", () => {
    expect(roof(50, { removedServiceIds: both })).toEqual({ ok: false, violation: "negativeTotal" });
  });

  it("PR-44: the bound: 1,000,000 + 10 × 10,000 − 1,100,000 = 0", () => {
    expect(roof(60, { removedServiceIds: both })).toMatchObject({ ok: true, breakdown: { total: 0 } });
  });

  it("PR-45: subtotal 10,000 with discounts 0 / 10,000 / 10,001", () => {
    expect(roof(61, { removedServiceIds: both })).toMatchObject({ ok: true, breakdown: { total: 10_000 } });
    expect(roof(61, { removedServiceIds: both, discountAmount: 10_000 })).toMatchObject({
      ok: true,
      breakdown: { total: 0 },
    });
    expect(roof(61, { removedServiceIds: both, discountAmount: 10_001 })).toEqual({
      ok: false,
      violation: "discountExceedsSubtotal",
    });
  });

  it("PR-46: added services may cover the credits — the rule is on the whole total (D-89)", () => {
    expect(roof(50, { removedServiceIds: both, added: [add("FIRE")] })).toMatchObject({
      ok: true,
      breakdown: { total: 100_000 },
    });
  });

  it("PR-47: BR-35 is checked before BR-52", () => {
    expect(roof(50, { removedServiceIds: both, discountAmount: 1 })).toEqual({ ok: false, violation: "negativeTotal" });
  });
});

describe("pricing: inputs and bounds (D-87)", () => {
  it.each([
    ["FIRE", 2],
    ["BUFFET", 3],
    ["BAND", 0],
    ["BAND", 10_001],
    ["BAND", 1.5],
  ])("PR-48: %s × %d is an invalid quantity", (serviceId, quantity) => {
    expect(quote({ added: [add(serviceId, quantity)] })).toEqual({
      ok: false,
      violation: "quantityInvalid",
      serviceId,
    });
  });

  it("PR-49: an inactive service is not added", () => {
    expect(quote({ added: [add("KOSHA")] })).toEqual({ ok: false, violation: "serviceInactive", serviceId: "KOSHA" });
  });

  it("PR-50: an unknown service", () => {
    expect(quote({ added: [add("NOPE")] })).toEqual({ ok: false, violation: "serviceUnknown", serviceId: "NOPE" });
  });

  it("PR-51: the same service twice among the added ones", () => {
    expect(quote({ added: [add("BAND", 1), add("BAND", 2)] })).toEqual({
      ok: false,
      violation: "addedDuplicate",
      serviceId: "BAND",
    });
  });

  it.each([0, 100_001, 2.5, -3])("PR-52: %d guests", (guests) => {
    expect(quote({ guests })).toEqual({ ok: false, violation: "guestsInvalid" });
  });

  it.each([-1, 0.5])("PR-52: a discount of %d", (discountAmount) => {
    expect(quote({ discountAmount })).toEqual({ ok: false, violation: "discountInvalid" });
  });

  it("PR-53: nothing exceeds the maximum amount", () => {
    const huge = { ...S.BUFFET, id: "HUGE", unitPrice: 100_000_000_000 };
    expect(quote({ guests: 2, added: [add("HUGE")] }, catalogFor(PACKAGES.GOLD, [huge]))).toEqual({
      ok: false,
      violation: "amountTooLarge",
    });
  });

  it("PR-54: an included service deactivated later stays included, price unchanged (D-80)", () => {
    const zaffaOff = { ...S.ZAFFA, isActive: false };
    const pkg = {
      ...PACKAGES.GOLD,
      included: PACKAGES.GOLD.included.map((i) => (i.service.id === "ZAFFA" ? { ...i, service: zaffaOff } : i)),
    };
    const b = priced({}, catalogFor(pkg));
    expect(b.total).toBe(6_000_000);
    expect(line(b, "ZAFFA", "package")).toMatchObject({ isRemoved: false, lineTotal: 0 });
  });
});

describe("pricing: everything together", () => {
  it("PR-55: summer evening, 230 guests, DJ swapped for an external one, buffet, band × 2, discount", () => {
    const b = priced({
      eventDate: "2027-07-10",
      guests: 230,
      removedServiceIds: ["DJ"],
      added: [add("DJ", 1, true), add("BUFFET"), add("BAND", 2)],
      discountAmount: 1_000_000,
    });
    expect(b.lines.map((l) => [l.serviceId, l.source, l.unitPrice, l.quantity, l.lineTotal])).toEqual([
      ["DJ", "package", 0, 1, -300_000],
      ["PHOTO", "package", 0, 2, 0],
      ["ZAFFA", "package", 0, 1, 0],
      ["WELCOME", "package", 0, 1, 0],
      ["DJ", "added", 0, 1, 100_000],
      ["BUFFET", "added", 18_000, 230, 4_140_000],
      ["BAND", "added", 400_000, 2, 800_000],
    ]);
    expect(b).toMatchObject({
      seasonId: SUMMER.id,
      basePrice: 7_500_000,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      extraGuests: 30,
      extraGuestsAmount: 450_000,
      itemsTotal: 5_040_000,
      externalFeesTotal: 100_000,
      removalCreditsTotal: 300_000,
      subtotal: 12_690_000,
      discountAmount: 1_000_000,
      total: 11_690_000,
    });
    // §3: summarize over the stored parts gives the same totals.
    expect(summarize(b)).toEqual({
      itemsTotal: 5_040_000,
      externalFeesTotal: 100_000,
      removalCreditsTotal: 300_000,
      subtotal: 12_690_000,
      total: 11_690_000,
    });
  });
});

it("the violation reported does not depend on item order", () => {
  const items = [add("KOSHA"), add("FIRE", 2)];
  expect(quote({ added: items })).toMatchObject({ violation: "serviceInactive" });
  expect(quote({ added: [...items].reverse() })).toMatchObject({ violation: "serviceInactive" });
});
