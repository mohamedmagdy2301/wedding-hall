import { describe, expect, it } from "vitest";
import {
  amendBooking,
  type AmendCatalog,
  type AmendRequest,
  type AmendSnapshot,
  type Amendment,
  type NewLine,
  type StoredLine,
} from "@/domain/amendment";
import { parsePounds } from "@/domain/money";
import type { PricingService } from "@/domain/pricing";

/**
 * PHASE7_PLAN §4.2–§4.3, the pure part (BR-40..43, D-92, D-93, Q7-05, Q7-07). The booking:
 * package 50,000 for 200 guests, extra guest 150 (fixed), an included DJ removable for
 * 3,000, an added kosha (fixed 4,000) and a drink per guest at 20 × 200 — total 58,000.
 * The catalog now: extra guest 180, drink 25, DJ removal 3,500, kosha 4,500.
 */

const p = (pounds: string) => {
  const piasters = parsePounds(pounds);
  if (piasters === null) throw new Error(`bad amount ${pounds}`);
  return piasters;
};

const service = (
  id: string,
  pricingType: PricingService["pricingType"],
  price: string,
  extra = {},
): PricingService => ({
  id,
  name: id,
  category: "service",
  pricingType,
  unitPrice: p(price),
  allowExternal: true,
  externalFee: p("1,000"),
  isActive: true,
  ...extra,
});

const line = (over: Partial<StoredLine> & Pick<StoredLine, "id" | "serviceId">): StoredLine => ({
  name: over.serviceId ?? "extra",
  category: "service",
  pricingType: "fixed",
  unitPrice: 0,
  quantity: 1,
  source: "added",
  isRemoved: false,
  removalCredit: 0,
  isExternal: false,
  externalFee: 0,
  lineTotal: 0,
  ...over,
});

const LINES: StoredLine[] = [
  line({ id: "dj", serviceId: "dj", source: "package", removalCredit: p("3,000") }),
  line({ id: "kosha", serviceId: "kosha", unitPrice: p("4,000"), lineTotal: p("4,000") }),
  line({
    id: "drink",
    serviceId: "drink",
    pricingType: "per_guest",
    unitPrice: p("20"),
    quantity: 200,
    lineTotal: p("4,000"),
  }),
];

const SNAPSHOT: AmendSnapshot = {
  guests: 200,
  baseGuests: 200,
  extraGuestPrice: p("150"),
  basePrice: p("50,000"),
  extraGuestsAmount: 0,
  discountAmount: 0,
};

const CATALOG: AmendCatalog = {
  extraGuestPrice: p("180"),
  services: new Map(
    [
      service("dj", "fixed", "5,000"),
      service("kosha", "fixed", "4,500"),
      service("drink", "per_guest", "25"),
      service("chairs", "per_unit", "1,500"),
      service("photo", "fixed", "2,500"),
      service("old", "fixed", "900", { isActive: false }),
    ].map((s) => [s.id, s]),
  ),
  removable: new Map([["dj", true]]),
};

const request = (over: Partial<AmendRequest> = {}, guests = 200): AmendRequest => ({
  guests,
  extraGuestUnitPrice: null,
  guestServicePrices: new Map(),
  add: [],
  remove: [],
  quantities: [],
  removeIncluded: [],
  restoreIncluded: [],
  ...over,
});

function amend(over: Partial<AmendRequest>, lines = LINES, snapshot = SNAPSHOT): Amendment {
  const result = amendBooking(lines, snapshot, CATALOG, request(over, snapshot.guests), "معازيم زيادة");
  if (!result.ok) throw new Error(`refused: ${result.violation} ${result.serviceId ?? ""}`);
  return result.amendment;
}

/** The booking after an amendment, to amend again: voided lines out, new lines in with ids. */
function apply(lines: StoredLine[], snapshot: AmendSnapshot, a: Amendment, tag: string) {
  const kept = lines
    .filter((l) => !a.voidLineIds.includes(l.id))
    .map((l) => {
      const change = a.includedChanges.find((c) => c.lineId === l.id);
      return change ? { ...l, isRemoved: change.isRemoved, lineTotal: change.lineTotal } : l;
    });
  const added = a.newLines.map((l: NewLine, i) => ({ ...l, id: `${tag}-${i}` }));
  return {
    lines: [...kept, ...added],
    snapshot: { ...snapshot, guests: a.guests, extraGuestsAmount: a.extraGuestsAmount },
  };
}

describe("the starting booking", () => {
  it("is 58,000 with nothing changed", () => {
    const a = amend({});
    expect(a.totals.total).toBe(p("58,000"));
    expect(a.changed).toBe(false);
  });
});

describe("guests after confirmation (BR-40, BR-43, D-92, D-93)", () => {
  it("GA-01: 200 → 230 adds 30 extra guests at 180 and 30 drinks at 25: 64,150", () => {
    const a = amend({ guests: 230 });
    expect(a.newLines.map((l) => [l.serviceId, l.quantity, l.lineTotal, l.source])).toEqual([
      [null, 30, p("5,400"), "guest_adjustment"],
      ["drink", 30, p("750"), "guest_adjustment"],
    ]);
    expect(a.totals.total).toBe(p("64,150"));
    expect(a.voidLineIds).toEqual([]);
  });

  it("GA-02: then 230 → 210 cancels 20 of GA-01's guests at their prices: 60,050", () => {
    const first = apply(LINES, SNAPSHOT, amend({ guests: 230 }), "ga1");
    const a = amend({ guests: 210 }, first.lines, first.snapshot);
    expect(a.voidLineIds.sort()).toEqual(["ga1-0", "ga1-1"]);
    expect(a.newLines.map((l) => [l.serviceId, l.quantity, l.lineTotal])).toEqual([
      [null, 10, p("1,800")],
      ["drink", 10, p("250")],
    ]);
    expect(a.totals.total).toBe(p("60,050"));
  });

  it("GA-03: then 230 → 190 cancels GA-01 entirely and 10 drinks at the fixed 20; the package price stays: 57,800", () => {
    const first = apply(LINES, SNAPSHOT, amend({ guests: 230 }), "ga1");
    const a = amend({ guests: 190 }, first.lines, first.snapshot);
    expect(a.voidLineIds.sort()).toEqual(["drink", "ga1-0", "ga1-1"]);
    expect(a.newLines.map((l) => [l.serviceId, l.quantity, l.lineTotal, l.source])).toEqual([
      ["drink", 190, p("3,800"), "added"],
    ]);
    expect(a.extraGuestsAmount).toBe(0);
    expect(a.totals.total).toBe(p("57,800"));
  });

  it("GA-04: 200 → 230 at a typed 160 per guest keeps 180 and asks a 600 discount (Q7-05)", () => {
    const a = amend({ guests: 230, extraGuestUnitPrice: p("160") });
    expect(a.newLines[0].unitPrice).toBe(p("180"));
    expect(a.overrideDiscounts).toEqual([{ serviceId: null, name: "معازيم زيادة", amount: p("600") }]);
    expect(a.totals.total).toBe(p("64,150"));
  });

  it("GA-05: 200 → 230 at a typed 200 per guest applies it: 64,750", () => {
    const a = amend({ guests: 230, extraGuestUnitPrice: p("200") });
    expect(a.newLines[0].lineTotal).toBe(p("6,000"));
    expect(a.overrides).toEqual([
      { serviceId: null, name: "معازيم زيادة", currentPrice: p("180"), typedPrice: p("200") },
    ]);
    expect(a.totals.total).toBe(p("64,750"));
  });

  it("GA-06: confirmed with 220 (20 extra at 150): 220 → 210 refunds 10 at the fixed 150, 210 → 230 charges 20 at 180", () => {
    const snapshot = { ...SNAPSHOT, guests: 220, extraGuestsAmount: p("3,000") };
    const lines = LINES.map((l) => (l.id === "drink" ? { ...l, quantity: 220, lineTotal: p("4,400") } : l));
    expect(amend({}, lines, snapshot).totals.total).toBe(p("61,400"));
    const down = amend({ guests: 210 }, lines, snapshot);
    expect(down.extraGuestsAmount).toBe(p("1,500"));
    expect(down.totals.total).toBe(p("61,400") - p("1,500") - p("200"));
    const after = apply(lines, snapshot, down, "d");
    const up = amend({ guests: 230 }, after.lines, after.snapshot);
    expect(up.newLines.map((l) => [l.serviceId, l.quantity, l.lineTotal])).toEqual([
      [null, 20, p("3,600")],
      ["drink", 20, p("500")],
    ]);
  });

  it("GA-07: below the base guests only per-guest services come off; nothing of the package price", () => {
    const a = amend({ guests: 150 });
    expect(a.extraGuestsAmount).toBe(0);
    expect(a.totals.total).toBe(p("58,000") - p("1,000"));
  });

  it("GA-08: an increase within the base guests charges only the per-guest services", () => {
    const snapshot = { ...SNAPSHOT, guests: 150 };
    const lines = LINES.map((l) => (l.id === "drink" ? { ...l, quantity: 150, lineTotal: p("3,000") } : l));
    const a = amend({ guests: 180 }, lines, snapshot);
    expect(a.newLines.map((l) => [l.serviceId, l.quantity])).toEqual([["drink", 30]]);
  });
});

describe("items after confirmation (BR-40, BR-43, Q7-07)", () => {
  it("IT-01: taking the kosha off returns its 4,000: 54,000", () => {
    const a = amend({ remove: ["kosha"] });
    expect(a.voidLineIds).toEqual(["kosha"]);
    expect(a.totals.total).toBe(p("54,000"));
  });

  it("IT-02: removing the included DJ takes the 3,000 fixed on the line, not today's 3,500: 55,000", () => {
    const a = amend({ removeIncluded: ["dj"] });
    expect(a.includedChanges).toEqual([{ lineId: "dj", isRemoved: true, lineTotal: -p("3,000") }]);
    expect(a.totals.total).toBe(p("55,000"));
    const after = apply(LINES, SNAPSHOT, a, "r");
    expect(amend({ restoreIncluded: ["dj"] }, after.lines, after.snapshot).totals.total).toBe(p("58,000"));
  });

  it("IT-03: 2 chairs at 1,500, then 3 at today's 1,700, then back to 2 takes the newest line off", () => {
    const two = amend({ add: [{ serviceId: "chairs", quantity: 2, isExternal: false, unitPrice: null }] });
    expect(two.totals.total).toBe(p("61,000"));
    const s1 = apply(LINES, SNAPSHOT, two, "c1");
    const catalog = {
      ...CATALOG,
      services: new Map([...CATALOG.services, ["chairs", service("chairs", "per_unit", "1,700")]]),
    };
    const threeResult = amendBooking(
      s1.lines,
      s1.snapshot,
      catalog,
      request({ quantities: [{ serviceId: "chairs", quantity: 3, unitPrice: null }] }),
      "x",
    );
    if (!threeResult.ok) throw new Error(threeResult.violation);
    expect(threeResult.amendment.newLines.map((l) => [l.quantity, l.lineTotal])).toEqual([[1, p("1,700")]]);
    expect(threeResult.amendment.totals.total).toBe(p("62,700"));
    const s2 = apply(s1.lines, s1.snapshot, threeResult.amendment, "c2");
    const back = amend({ quantities: [{ serviceId: "chairs", quantity: 2, unitPrice: null }] }, s2.lines, s2.snapshot);
    expect(back.voidLineIds).toEqual(["c2-0"]);
    expect(back.totals.total).toBe(p("61,000"));
  });

  it("a fixed service added below its price keeps the price and asks the difference", () => {
    const a = amend({ add: [{ serviceId: "photo", quantity: 1, isExternal: false, unitPrice: p("2,000") }] });
    expect(a.totals.total).toBe(p("60,500"));
    expect(a.overrideDiscounts).toEqual([{ serviceId: "photo", name: "photo", amount: p("500") }]);
  });

  it("a per-guest service added after confirmation covers all the guests now", () => {
    const lines = LINES.filter((l) => l.id !== "drink");
    const a = amend({ add: [{ serviceId: "drink", quantity: 1, isExternal: false, unitPrice: null }] }, lines);
    expect(a.newLines.map((l) => [l.quantity, l.lineTotal])).toEqual([[200, p("5,000")]]);
  });

  it("the removed DJ comes back as an external provider only (D-90), in the same change", () => {
    const external = { serviceId: "dj", quantity: 1, isExternal: true, unitPrice: null };
    const a = amend({ removeIncluded: ["dj"], add: [external] });
    expect(a.totals.total).toBe(p("56,000"));
    const internal = amendBooking(
      LINES,
      SNAPSHOT,
      CATALOG,
      request({ removeIncluded: ["dj"], add: [{ ...external, isExternal: false }] }),
      "x",
    );
    expect(internal).toMatchObject({ ok: false, violation: "alreadyIncluded" });
  });

  it("refuses what the catalog and the rules refuse", () => {
    const refuse = (over: Partial<AmendRequest>) => amendBooking(LINES, SNAPSHOT, CATALOG, request(over), "x");
    const add = (serviceId: string, extra = {}) => ({
      add: [{ serviceId, quantity: 1, isExternal: false, unitPrice: null, ...extra }],
    });
    expect(refuse(add("old"))).toMatchObject({ violation: "serviceInactive" });
    expect(refuse(add("kosha"))).toMatchObject({ violation: "addedDuplicate" });
    expect(refuse(add("dj"))).toMatchObject({ violation: "alreadyIncluded" });
    expect(refuse(add("nope"))).toMatchObject({ violation: "serviceUnknown" });
    expect(refuse({ remove: ["photo"] })).toMatchObject({ violation: "lineNotFound" });
    expect(
      refuse({ remove: ["kosha"], quantities: [{ serviceId: "kosha", quantity: 2, unitPrice: null }] }),
    ).toMatchObject({ violation: "changeDuplicate" });
    expect(refuse({ quantities: [{ serviceId: "kosha", quantity: 2, unitPrice: null }] })).toMatchObject({
      violation: "quantityNotAdjustable",
    });
    expect(refuse({ restoreIncluded: ["dj"] })).toMatchObject({ violation: "includedNotRemoved" });
    expect(refuse({ guests: 0 })).toMatchObject({ violation: "guestsInvalid" });
    expect(refuse({ extraGuestUnitPrice: -1, guests: 210 })).toMatchObject({ violation: "priceInvalid" });
  });

  it("BR-52: lines taken off below the approved discount are refused", () => {
    const result = amendBooking(
      LINES,
      { ...SNAPSHOT, discountAmount: p("56,000") },
      CATALOG,
      request({ remove: ["kosha"] }),
      "x",
    );
    expect(result).toMatchObject({ ok: false, violation: "discountExceedsSubtotal" });
  });
});
