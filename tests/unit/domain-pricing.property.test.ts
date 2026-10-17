import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PRICING_TYPES, SLOT_KINDS, type PackagePrice } from "@/domain/catalog";
import {
  MAX_GUESTS,
  quotePrice,
  summarize,
  type AddedItemRequest,
  type IncludedService,
  type PriceBreakdown,
  type PricingCatalog,
  type PricingService,
  type QuoteRequest,
  type QuoteResult,
} from "@/domain/pricing";

/**
 * PHASE4_PLAN §6.4: properties P-01..P-10 on random catalogs and requests within D-79 / D-87.
 * The generated requests respect the item rules (D-90, BR-33, BR-34), so the only possible
 * refusals are BR-35 and BR-52 — any other one fails the property. A failure prints the seed
 * and the smallest counterexample, which then becomes a fixed case in domain-pricing.test.ts.
 */

const RUNS = { numRuns: 1000 };
const SUMMER = { id: "summer", startDate: "2027-06-01", endDate: "2027-09-30" };
const SERVICE_IDS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];

type Scenario = { catalog: PricingCatalog; request: QuoteRequest };

const serviceArb = (id: string) =>
  fc
    .record({
      pricingType: fc.constantFrom(...PRICING_TYPES),
      unitPrice: fc.integer({ min: 0, max: 1_000_000 }),
      allowExternal: fc.boolean(),
      externalFee: fc.integer({ min: 0, max: 1_000_000 }),
    })
    .map((r): PricingService => ({
      id,
      name: id,
      category: "service",
      ...r,
      externalFee: r.allowExternal ? r.externalFee : 0,
      isActive: true,
    }));

/** Per service: is it included, is it removed, is it added (and how)? */
const choiceArb = fc.record({
  included: fc.option(
    fc.record({
      quantity: fc.integer({ min: 1, max: 10 }),
      removable: fc.boolean(),
      credit: fc.integer({ min: 0, max: 3_000_000 }),
    }),
    { nil: null },
  ),
  remove: fc.boolean(),
  add: fc.constantFrom("none", "internal", "external"),
  quantity: fc.integer({ min: 1, max: 20 }),
});

const priceArb = fc.integer({ min: 1, max: 1_000_000_000 });

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    services: fc.tuple(...SERVICE_IDS.map(serviceArb)),
    choices: fc.tuple(...SERVICE_IDS.map(() => choiceArb)),
    slotKind: fc.constantFrom(...SLOT_KINDS),
    regular: fc.record({ day: fc.option(priceArb), evening: fc.option(priceArb), full_day: fc.option(priceArb) }),
    summer: fc.record({ day: fc.option(priceArb), evening: fc.option(priceArb), full_day: fc.option(priceArb) }),
    forcedRegular: priceArb,
    baseGuests: fc.integer({ min: 0, max: 1000 }),
    extraGuestPrice: fc.integer({ min: 0, max: 100_000 }),
    guests: fc.integer({ min: 1, max: 5000 }),
    eventDate: fc.constantFrom("2027-01-15", "2027-06-01", "2027-07-10", "2027-09-30", "2027-10-01"),
    seasonActive: fc.boolean(),
    discountAmount: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 2_000_000_000 })),
  })
  .map((g): Scenario => {
    const prices: PackagePrice[] = [];
    for (const kind of SLOT_KINDS) {
      const regular = g.regular[kind] ?? (kind === g.slotKind ? g.forcedRegular : null);
      if (regular === null) continue;
      prices.push({ slotKind: kind, seasonId: null, price: regular });
      const seasonal = g.summer[kind];
      if (seasonal !== null) prices.push({ slotKind: kind, seasonId: SUMMER.id, price: seasonal });
    }
    const included: IncludedService[] = [];
    const removed: string[] = [];
    const added: AddedItemRequest[] = [];
    g.services.forEach((service, i) => {
      const c = g.choices[i];
      const perUnit = service.pricingType === "per_unit";
      if (c.included) {
        const removalCredit = c.included.removable ? c.included.credit : 0;
        included.push({
          service,
          quantity: perUnit ? c.included.quantity : 1,
          removable: c.included.removable,
          removalCredit,
        });
        if (c.included.removable && c.remove) removed.push(service.id);
      }
      if (c.add === "none") return;
      const isExternal = c.add === "external" && service.allowExternal;
      const isRemoved = removed.includes(service.id);
      if (c.included && !isRemoved && !perUnit) return; // D-90
      if (isRemoved && !isExternal) return; // D-90
      added.push({ serviceId: service.id, quantity: perUnit ? c.quantity : 1, isExternal });
    });
    return {
      catalog: {
        package: { baseGuests: g.baseGuests, extraGuestPrice: g.extraGuestPrice, prices, included },
        activeSeasons: g.seasonActive ? [SUMMER] : [],
        services: new Map(g.services.map((s) => [s.id, s])),
      },
      request: {
        slotKind: g.slotKind,
        eventDate: g.eventDate,
        guests: g.guests,
        added,
        removedServiceIds: removed,
        discountAmount: g.discountAmount,
      },
    };
  });

/** BR-32 read directly, as an independent model of the subtotal. */
function modelSubtotal({ catalog, request }: Scenario): number {
  const { prices, baseGuests, extraGuestPrice, included } = catalog.package;
  const inSeason = catalog.activeSeasons.some(
    (s) => s.startDate <= request.eventDate && request.eventDate <= s.endDate,
  );
  const find = (seasonId: string | null) =>
    prices.find((p) => p.slotKind === request.slotKind && p.seasonId === seasonId)?.price;
  const base = (inSeason ? find(SUMMER.id) : undefined) ?? find(null)!;
  const extra = Math.max(0, request.guests - baseGuests) * extraGuestPrice;
  let items = 0;
  for (const item of request.added) {
    const s = catalog.services.get(item.serviceId)!;
    if (item.isExternal) items += s.externalFee;
    else if (s.pricingType === "fixed") items += s.unitPrice;
    else if (s.pricingType === "per_unit") items += s.unitPrice * item.quantity;
    else items += s.unitPrice * request.guests;
  }
  const credits = included
    .filter((i) => request.removedServiceIds.includes(i.service.id))
    .reduce((sum, i) => sum + i.removalCredit, 0);
  return base + extra + items - credits;
}

const okOf = (result: QuoteResult): PriceBreakdown | null => (result.ok ? result.breakdown : null);
const sortedLines = (b: PriceBreakdown) =>
  [...b.lines].sort((x, y) => `${x.source}|${x.serviceId}`.localeCompare(`${y.source}|${y.serviceId}`));
const sumLines = (b: PriceBreakdown) => b.lines.reduce((sum, l) => sum + l.lineTotal, 0);
const withRequest = (s: Scenario, change: Partial<QuoteRequest>) => quotePrice(s.catalog, { ...s.request, ...change });

describe("pricing properties (fast-check)", () => {
  it("P-01 (BR-35): total ≥ 0, and a negative subtotal is always refused — the engine agrees with BR-32", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const result = quotePrice(s.catalog, s.request);
        const subtotal = modelSubtotal(s);
        if (subtotal < 0) {
          expect(result).toEqual({ ok: false, violation: "negativeTotal" });
          return;
        }
        if (s.request.discountAmount > subtotal) {
          expect(result).toEqual({ ok: false, violation: "discountExceedsSubtotal" });
          return;
        }
        expect(result).toMatchObject({ ok: true, breakdown: { subtotal, total: subtotal - s.request.discountAmount } });
        expect(okOf(result)!.total).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it("P-02 (BR-32, D-85): the lines add up to the total", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const b = okOf(quotePrice(s.catalog, s.request));
        if (!b) return;
        expect(b.basePrice + b.extraGuestsAmount + sumLines(b) - b.discountAmount).toBe(b.total);
        expect(sumLines(b)).toBe(b.itemsTotal - b.removalCreditsTotal);
        expect(b.subtotal - b.discountAmount).toBe(b.total);
        expect(b.externalFeesTotal).toBeLessThanOrEqual(b.itemsTotal);
      }),
      RUNS,
    );
  });

  it("P-03 (BR-32): the order of added and removed services does not change the result", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer(), (s, seed) => {
        const shuffle = <T>(xs: readonly T[]) =>
          xs
            .map((x, i) => ({ x, k: Math.sin(seed + i * 7919) }))
            .sort((a, b) => a.k - b.k)
            .map((e) => e.x);
        const a = quotePrice(s.catalog, s.request);
        const b = withRequest(s, {
          added: shuffle(s.request.added),
          removedServiceIds: shuffle(s.request.removedServiceIds),
        });
        if (!a.ok || !b.ok) {
          expect(b).toEqual(a);
          return;
        }
        expect({ ...b.breakdown, lines: sortedLines(b.breakdown) }).toEqual({
          ...a.breakdown,
          lines: sortedLines(a.breakdown),
        });
      }),
      RUNS,
    );
  });

  it("P-04 (BR-36): every amount is a safe integer, non-negative except a removed line's credit", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const b = okOf(quotePrice(s.catalog, s.request));
        if (!b) return;
        const amounts = [
          b.basePrice,
          b.extraGuestPrice,
          b.extraGuestsAmount,
          b.itemsTotal,
          b.externalFeesTotal,
          b.removalCreditsTotal,
          b.subtotal,
          b.discountAmount,
          b.total,
        ];
        for (const l of b.lines) amounts.push(l.unitPrice, l.quantity, l.externalFee, l.removalCredit);
        for (const n of amounts) expect(Number.isSafeInteger(n) && n >= 0).toBe(true);
        for (const l of b.lines) {
          expect(Number.isSafeInteger(l.lineTotal)).toBe(true);
          expect(l.lineTotal < 0).toBe(l.isRemoved && l.removalCredit > 0);
        }
      }),
      RUNS,
    );
  });

  it("P-05 (BR-32): one more guest never lowers the total", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const before = okOf(quotePrice(s.catalog, s.request));
        if (!before || s.request.guests >= MAX_GUESTS) return;
        const after = okOf(withRequest(s, { guests: s.request.guests + 1 }));
        expect(after).not.toBeNull();
        expect(after!.total).toBeGreaterThanOrEqual(before.total);
      }),
      RUNS,
    );
  });

  it("P-06 (BR-32, BR-33): adding a service raises the total by its line; removing one lowers it by its credit", () => {
    const extra: PricingService = {
      id: "extra",
      name: "extra",
      category: "show",
      pricingType: "per_unit",
      unitPrice: 123_457,
      allowExternal: false,
      externalFee: 0,
      isActive: true,
    };
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 1, max: 30 }), (s, quantity) => {
        const base = okOf(withRequest(s, { discountAmount: 0 }));
        if (!base) return;
        const catalog = { ...s.catalog, services: new Map([...s.catalog.services, [extra.id, extra]]) };
        const added = okOf(
          quotePrice(catalog, {
            ...s.request,
            discountAmount: 0,
            added: [...s.request.added, { serviceId: extra.id, quantity, isExternal: false }],
          }),
        );
        expect(added!.total - base.total).toBe(123_457 * quantity);

        const candidate = s.catalog.package.included.find(
          (i) =>
            i.removable &&
            !s.request.removedServiceIds.includes(i.service.id) &&
            !s.request.added.some((a) => a.serviceId === i.service.id),
        );
        if (!candidate) return;
        const removed = withRequest(s, {
          discountAmount: 0,
          removedServiceIds: [...s.request.removedServiceIds, candidate.service.id],
        });
        if (base.total < candidate.removalCredit) {
          expect(removed).toMatchObject({ violation: "negativeTotal" });
          return;
        }
        expect(okOf(removed)!.total).toBe(base.total - candidate.removalCredit);
      }),
      RUNS,
    );
  });

  it("P-07 (BR-52): the discount comes off exactly, up to the subtotal", () => {
    fc.assert(
      fc.property(scenarioArb, fc.double({ min: 0, max: 1, noNaN: true }), (s, fraction) => {
        const zero = okOf(withRequest(s, { discountAmount: 0 }));
        if (!zero) return;
        const d = Math.floor(zero.subtotal * fraction);
        expect(okOf(withRequest(s, { discountAmount: d }))!.total).toBe(zero.total - d);
        expect(withRequest(s, { discountAmount: zero.subtotal + 1 })).toEqual({
          ok: false,
          violation: "discountExceedsSubtotal",
        });
      }),
      RUNS,
    );
  });

  it("P-08 (BR-34, D-39): an external line's quantity never changes the total", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 1, max: 10_000 }), (s, quantity) => {
        const b = okOf(quotePrice(s.catalog, s.request));
        if (!b) return;
        const added = s.request.added.map((a) =>
          a.isExternal && s.catalog.services.get(a.serviceId)!.pricingType === "per_unit" ? { ...a, quantity } : a,
        );
        expect(okOf(withRequest(s, { added }))!.total).toBe(b.total);
      }),
      RUNS,
    );
  });

  it("P-09 (BR-30): without a season price for the slot, the season makes no difference", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const hasSeasonPrice = s.catalog.package.prices.some(
          (p) => p.slotKind === s.request.slotKind && p.seasonId !== null,
        );
        if (hasSeasonPrice) return;
        const withSeason = quotePrice({ ...s.catalog, activeSeasons: [SUMMER] }, s.request);
        const without = quotePrice({ ...s.catalog, activeSeasons: [] }, s.request);
        if (!withSeason.ok || !without.ok) {
          expect(withSeason).toEqual(without);
          return;
        }
        expect(withSeason.breakdown.total).toBe(without.breakdown.total);
        expect(withSeason.breakdown.seasonId).toBeNull();
      }),
      RUNS,
    );
  });

  it("P-10 (rule 8): pure — inputs untouched, same output twice, and summarize agrees", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object" && !(value instanceof Map)) {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
      }
      return value;
    };
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const before = structuredClone(s);
        deepFreeze(s.request);
        deepFreeze(s.catalog.package);
        const first = quotePrice(s.catalog, s.request);
        const second = quotePrice(s.catalog, s.request);
        expect(second).toEqual(first);
        expect(s).toEqual(before);
        if (!first.ok) return;
        const { itemsTotal, externalFeesTotal, removalCreditsTotal, subtotal, total } = first.breakdown;
        expect(summarize(first.breakdown)).toEqual({
          itemsTotal,
          externalFeesTotal,
          removalCreditsTotal,
          subtotal,
          total,
        });
      }),
      RUNS,
    );
  });
});
