import type { PackagePrice } from "@/domain/catalog";
import type { IncludedService, PricingCatalog, PricingSeason, PricingService, QuoteRequest } from "@/domain/pricing";

/**
 * The fixed test catalog of PHASE4_PLAN §6.1. Amounts in piasters. Every expected total in
 * the tests is written by hand from these numbers, never computed by the engine.
 */

export const SUMMER: PricingSeason = { id: "season-summer", startDate: "2027-06-01", endDate: "2027-09-30" };
/** Inactive: not in `activeSeasons`, but GOLD keeps a price for it (D-78). */
export const EID = { id: "season-eid", startDate: "2027-03-10", endDate: "2027-03-14" };

const service = (s: Omit<PricingService, "isActive" | "allowExternal" | "externalFee"> & Partial<PricingService>) =>
  ({ allowExternal: false, externalFee: 0, isActive: true, ...s }) satisfies PricingService;

export const S = {
  DJ: service({
    id: "DJ",
    name: "دي جي",
    category: "show",
    pricingType: "fixed",
    unitPrice: 500_000,
    allowExternal: true,
    externalFee: 100_000,
  }),
  PHOTO: service({
    id: "PHOTO",
    name: "تصوير",
    category: "service",
    pricingType: "per_unit",
    unitPrice: 250_000,
    allowExternal: true,
  }),
  BUFFET: service({
    id: "BUFFET",
    name: "بوفيه عشاء",
    category: "hospitality",
    pricingType: "per_guest",
    unitPrice: 18_000,
  }),
  ZAFFA: service({ id: "ZAFFA", name: "زفة", category: "show", pricingType: "fixed", unitPrice: 300_000 }),
  WELCOME: service({
    id: "WELCOME",
    name: "مشروب ترحيب",
    category: "hospitality",
    pricingType: "per_guest",
    unitPrice: 2_550,
  }),
  JUICE: service({ id: "JUICE", name: "عصير", category: "hospitality", pricingType: "per_guest", unitPrice: 1_275 }),
  BAND: service({
    id: "BAND",
    name: "فرقة",
    category: "show",
    pricingType: "per_unit",
    unitPrice: 400_000,
    allowExternal: true,
    externalFee: 150_000,
  }),
  FIRE: service({ id: "FIRE", name: "ألعاب نارية", category: "show", pricingType: "fixed", unitPrice: 200_000 }),
  DECOR: service({ id: "DECOR", name: "ديكور", category: "service", pricingType: "fixed", unitPrice: 800_000 }),
  KOSHA: service({
    id: "KOSHA",
    name: "كوشة ملكية",
    category: "service",
    pricingType: "fixed",
    unitPrice: 750_000,
    isActive: false,
  }),
};

const price = (slotKind: PackagePrice["slotKind"], amount: number, seasonId: string | null = null): PackagePrice => ({
  slotKind,
  seasonId,
  price: amount,
});

const inc = (s: PricingService, quantity: number, removalCredit: number | null): IncludedService => ({
  service: s,
  quantity,
  removable: removalCredit !== null,
  removalCredit: removalCredit ?? 0,
});

export const PACKAGES = {
  GOLD: {
    baseGuests: 200,
    extraGuestPrice: 15_000,
    prices: [
      price("day", 4_000_000),
      price("evening", 6_000_000),
      price("full_day", 9_000_000),
      price("evening", 7_500_000, SUMMER.id),
      price("full_day", 11_000_000, SUMMER.id),
      price("evening", 8_000_000, EID.id),
    ],
    included: [inc(S.DJ, 1, 300_000), inc(S.PHOTO, 2, 200_000), inc(S.ZAFFA, 1, null), inc(S.WELCOME, 1, 400_000)],
  },
  RENT: { baseGuests: 0, extraGuestPrice: 25_000, prices: [price("evening", 2_000_000)], included: [] },
  ROOF: {
    baseGuests: 50,
    extraGuestPrice: 10_000,
    prices: [price("day", 1_000_000)],
    included: [inc(S.DJ, 1, 600_000), inc(S.DECOR, 1, 500_000)],
  },
} satisfies Record<string, PricingCatalog["package"]>;

export const catalogFor = (
  pkg: PricingCatalog["package"],
  services: PricingService[] = Object.values(S),
): PricingCatalog => ({
  package: pkg,
  activeSeasons: [SUMMER],
  services: new Map(services.map((s) => [s.id, s])),
});

/** The default case: GOLD, evening, 2027-01-15 (no season), 200 guests, nothing added or removed. */
export const DEFAULT_REQUEST: QuoteRequest = {
  slotKind: "evening",
  eventDate: "2027-01-15",
  guests: 200,
  added: [],
  removedServiceIds: [],
  discountAmount: 0,
};
