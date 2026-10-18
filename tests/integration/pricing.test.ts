import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { packages, seasons, services, spaces, venues } from "@/db/schema";
import { getPackage } from "@/modules/packages/service";
import { VENUE_DEFAULTS } from "@/modules/settings/setup";
import { catalogSpecs } from "@/server/specs/catalog";
import type { ProtectedSpec } from "@/server/specs/define";
import { pricingSpecs } from "@/server/specs/pricing";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { userSpecs } from "@/server/specs/users";
import { connectTestDb, truncateAll } from "./helpers/db";
import { addStaff, auditActions, callSpec, setUpVenueWithOwner } from "./helpers/fixtures";

/**
 * PHASE4_PLAN §6.5 (PQ-01..PQ-07): `pricing.quote` on the catalog of §6.1, stored through
 * the phase 3 operations (amounts typed in pounds). Expected piasters are the hand-computed
 * numbers of the unit cases.
 */

type AnySpec = ProtectedSpec<z.ZodType, unknown>;
type Result = { ok: true; data: any } | { ok: false; error: { code: string; rule?: string; fieldErrors?: object } }; // eslint-disable-line @typescript-eslint/no-explicit-any

const slots = { day: { start: "12:00", end: "17:00" }, evening: { start: "18:00", end: "23:00" } };

const ok = (result: Result) => {
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.rule ?? ""}`);
  return result.data;
};

describe("pricing.quote (phase 4)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  async function scenario() {
    const base = await setUpVenueWithOwner(handle);
    const manager = await addStaff(handle, base.owner.actor, "manager", [base.roleId("مدير")]);
    const reception = await addStaff(handle, base.owner.actor, "reception", [base.roleId("استقبال/حجوزات")]);
    const accountant = await addStaff(handle, base.owner.actor, "accountant", [base.roleId("محاسب")]);
    const call = (spec: unknown, input: unknown, token: string | undefined = manager.token) =>
      callSpec(handle, spec as AnySpec, token, input) as Promise<Result>;

    const spaceId = ok(await call(spaceSpecs.createSpace, { name: "القاعة الكبرى", capacityMax: "", ...slots })).id;
    const otherSpaceId = ok(await call(spaceSpecs.createSpace, { name: "الروف", capacityMax: "", ...slots })).id;
    const season = async (name: string, startDate: string, endDate: string) =>
      ok(await call(settingsSpecs.createSeason, { name, startDate, endDate })).id as string;
    const summer = await season("الصيف", "2027-06-01", "2027-09-30");
    const eid = await season("العيد", "2027-03-10", "2027-03-14");

    const service = async (name: string, pricingType: string, unitPrice: string, externalFee: string | null = null) =>
      ok(
        await call(catalogSpecs.createService, {
          name,
          category: "service",
          pricingType,
          unitPrice,
          allowExternal: externalFee !== null,
          externalFee: externalFee ?? "",
        }),
      ).id as string;
    const S = {
      DJ: await service("دي جي", "fixed", "5000", "1000"),
      PHOTO: await service("تصوير", "per_unit", "2500", ""),
      BUFFET: await service("بوفيه عشاء", "per_guest", "180"),
      ZAFFA: await service("زفة", "fixed", "3000"),
      WELCOME: await service("مشروب ترحيب", "per_guest", "25.50"),
      BAND: await service("فرقة", "per_unit", "4000", "1500"),
      KOSHA: await service("كوشة ملكية", "fixed", "7500"),
    };
    ok(await call(catalogSpecs.setServiceActive, { serviceId: S.KOSHA, active: false }));

    const gold = ok(
      await call(catalogSpecs.createPackage, {
        spaceId,
        name: "الذهبي",
        description: "",
        baseGuests: "200",
        extraGuestPrice: "150",
        isActive: true,
        prices: [
          { slotKind: "day", seasonId: null, price: "40000" },
          { slotKind: "evening", seasonId: null, price: "60000" },
          { slotKind: "full_day", seasonId: null, price: "90000" },
          { slotKind: "evening", seasonId: summer, price: "75000" },
          { slotKind: "full_day", seasonId: summer, price: "110000" },
          { slotKind: "evening", seasonId: eid, price: "80000" },
        ],
        items: [
          { serviceId: S.DJ, quantity: "1", removable: true, removalCredit: "3000" },
          { serviceId: S.PHOTO, quantity: "2", removable: true, removalCredit: "2000" },
          { serviceId: S.ZAFFA, quantity: "1", removable: false, removalCredit: "" },
          { serviceId: S.WELCOME, quantity: "1", removable: true, removalCredit: "4000" },
        ],
      }),
    ).id as string;
    ok(await call(settingsSpecs.setSeasonActive, { seasonId: eid, active: false }));

    const quote = (input: Record<string, unknown> = {}, token?: string) =>
      call(
        pricingSpecs.quote,
        { spaceId, packageId: gold, slotKind: "evening", eventDate: "2027-01-15", guests: "200", ...input },
        token,
      );
    return { ...base, manager, reception, accountant, call, quote, spaceId, otherSpaceId, summer, S, gold };
  }

  it("PQ-01: the stored catalog prices PR-55, PR-06 and PR-34 exactly", async () => {
    const s = await scenario();
    const b = ok(
      await s.quote({
        eventDate: "2027-07-10",
        guests: "230",
        removedServiceIds: [s.S.DJ],
        items: [
          { serviceId: s.S.DJ, quantity: "1", isExternal: true },
          { serviceId: s.S.BUFFET, quantity: "1", isExternal: false },
          { serviceId: s.S.BAND, quantity: "2", isExternal: false },
        ],
        discountAmount: "10000",
      }),
    );
    const names = new Map(Object.entries(s.S).map(([k, v]) => [v, k]));
    expect(
      b.lines.map(
        (l: { serviceId: string; source: string; unitPrice: number; quantity: number; lineTotal: number }) => [
          names.get(l.serviceId),
          l.source,
          l.unitPrice,
          l.quantity,
          l.lineTotal,
        ],
      ),
    ).toEqual([
      ["DJ", "package", 0, 1, -300_000],
      ["PHOTO", "package", 0, 2, 0],
      ["ZAFFA", "package", 0, 1, 0],
      ["WELCOME", "package", 0, 1, 0],
      ["DJ", "added", 0, 1, 100_000],
      ["BUFFET", "added", 18_000, 230, 4_140_000],
      ["BAND", "added", 400_000, 2, 800_000],
    ]);
    expect(b).toMatchObject({
      seasonId: s.summer,
      basePrice: 7_500_000,
      extraGuestsAmount: 450_000,
      itemsTotal: 5_040_000,
      externalFeesTotal: 100_000,
      removalCreditsTotal: 300_000,
      subtotal: 12_690_000,
      discountAmount: 1_000_000,
      total: 11_690_000,
    });

    expect(ok(await s.quote({ eventDate: "2027-07-10", slotKind: "day" }))).toMatchObject({
      total: 4_000_000,
      seasonId: null,
      dateSeasonId: s.summer,
    });
    const swap = {
      removedServiceIds: [s.S.DJ],
      items: [{ serviceId: s.S.DJ, quantity: "1", isExternal: true }],
    };
    expect(ok(await s.quote(swap)).total).toBe(5_800_000);
  });

  it("D-116: included services keep the package's order — on every read, and after a save that reorders them", async () => {
    const s = await scenario();
    const names = new Map(Object.entries(s.S).map(([k, v]) => [v, k]));
    const includedOrder = async () => {
      const b = ok(await s.quote());
      return b.lines
        .filter((l: { source: string }) => l.source === "package")
        .map((l: { serviceId: string }) => names.get(l.serviceId));
    };
    // Saved in one transaction, so created_at is the same for all four (the PQ-01 flake).
    for (let i = 0; i < 10; i += 1) expect(await includedOrder()).toEqual(["DJ", "PHOTO", "ZAFFA", "WELCOME"]);

    const pkg = (await getPackage(db, s.manager.actor, s.gold)).package;
    ok(
      await s.call(catalogSpecs.updatePackage, {
        packageId: s.gold,
        version: pkg.version,
        name: "الذهبي",
        description: "",
        baseGuests: "200",
        extraGuestPrice: "150",
        isActive: true,
        prices: pkg.prices.map((p) => ({ ...p, price: String(p.price / 100) })),
        items: [...pkg.items].reverse().map((i) => ({
          serviceId: i.serviceId,
          quantity: String(i.quantity),
          removable: i.removable,
          removalCredit: i.removable ? String(i.removalCredit / 100) : "",
        })),
      }),
    );
    expect(await includedOrder()).toEqual(["WELCOME", "ZAFFA", "PHOTO", "DJ"]);
    expect((await getPackage(db, s.manager.actor, s.gold)).package.items.map((i) => names.get(i.serviceId))).toEqual([
      "WELCOME",
      "ZAFFA",
      "PHOTO",
      "DJ",
    ]);
  });

  it("PQ-01: engine refusals come back with their rule and the service as the field", async () => {
    const s = await scenario();
    expect(await s.quote({ removedServiceIds: [s.S.ZAFFA] })).toMatchObject({
      ok: false,
      error: {
        code: "BUSINESS_RULE_VIOLATION",
        rule: "BR-33",
        fieldErrors: { [`removedServiceIds.${s.S.ZAFFA}`]: expect.any(String) },
      },
    });
    expect(await s.quote({ items: [{ serviceId: s.S.BUFFET, quantity: "1", isExternal: true }] })).toMatchObject({
      ok: false,
      error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-34" },
    });
    expect(await s.quote({ items: [{ serviceId: s.S.KOSHA, quantity: "1", isExternal: false }] })).toMatchObject({
      ok: false,
      error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-87" },
    });
    expect(await s.quote({ items: [{ serviceId: s.S.DJ, quantity: "1", isExternal: false }] })).toMatchObject({
      ok: false,
      error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-90" },
    });
    expect(await s.quote({ discountAmount: "60000.01" })).toMatchObject({
      ok: false,
      error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-52" },
    });
    expect(ok(await s.quote({ discountAmount: "60000" })).total).toBe(0);
  });

  it("PQ-02: always the current catalog — season activation (D-78) and price edits apply at once", async () => {
    const s = await scenario();
    const summerEvening = { eventDate: "2027-07-10" };
    expect(ok(await s.quote(summerEvening)).total).toBe(7_500_000);
    ok(await s.call(settingsSpecs.setSeasonActive, { seasonId: s.summer, active: false }));
    expect(ok(await s.quote(summerEvening))).toMatchObject({ total: 6_000_000, seasonId: null, dateSeasonId: null });
    ok(await s.call(settingsSpecs.setSeasonActive, { seasonId: s.summer, active: true }));
    expect(ok(await s.quote(summerEvening)).total).toBe(7_500_000);

    const { package: p } = await getPackage(db, s.owner.actor, s.gold);
    ok(
      await s.call(catalogSpecs.updatePackage, {
        packageId: s.gold,
        version: p.version,
        name: p.name,
        description: "",
        baseGuests: p.baseGuests,
        extraGuestPrice: String(p.extraGuestPrice / 100),
        isActive: true,
        prices: p.prices.map((x) => ({
          ...x,
          price: x.slotKind === "evening" && x.seasonId === null ? "65000" : String(x.price / 100),
        })),
        items: p.items.map((i) => ({ ...i, removalCredit: String(i.removalCredit / 100) })),
      }),
    );
    expect(ok(await s.quote()).total).toBe(6_500_000);
  });

  it("PQ-03: an inactive package, a package on an inactive space (BR-06), or on another space", async () => {
    const s = await scenario();
    const version = (await getPackage(db, s.owner.actor, s.gold)).package.version;
    ok(await s.call(catalogSpecs.setPackageActive, { packageId: s.gold, version, active: false }));
    expect(await s.quote()).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-87" } });
    ok(await s.call(catalogSpecs.setPackageActive, { packageId: s.gold, version: version + 1, active: true }));
    expect(ok(await s.quote()).total).toBe(6_000_000);

    ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: s.spaceId, active: false }));
    expect(await s.quote()).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-06" } });
    ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: s.spaceId, active: true }));

    expect(await s.quote({ spaceId: s.otherSpaceId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await s.quote({ slotKind: "day", packageId: s.gold })).toMatchObject({ ok: true });
  });

  it("PQ-04: another venue's package, service or season is invisible (T-05)", async () => {
    const s = await scenario();
    const [other] = await db
      .insert(venues)
      .values({ name: "منشأة أخرى", ...VENUE_DEFAULTS })
      .returning({ id: venues.id });
    const [foreignSpace] = await db
      .insert(spaces)
      .values({ venueId: other.id, name: "قاعة" })
      .returning({ id: spaces.id });
    const [foreignPackage] = await db
      .insert(packages)
      .values({ venueId: other.id, spaceId: foreignSpace.id, name: "باكيج", baseGuests: 0, extraGuestPrice: 0 })
      .returning({ id: packages.id });
    const [foreignService] = await db
      .insert(services)
      .values({ venueId: other.id, name: "خدمة", category: "service", pricingType: "fixed", unitPrice: 1 })
      .returning({ id: services.id });
    // Active, and contains the default date: must not show up as the date's season.
    await db
      .insert(seasons)
      .values({ venueId: other.id, name: "موسم", startDate: "2027-01-01", endDate: "2027-01-31" });

    const notFound = { ok: false, error: { code: "NOT_FOUND" } };
    expect(await s.quote({ spaceId: foreignSpace.id, packageId: foreignPackage.id })).toMatchObject(notFound);
    expect(
      await s.quote({ items: [{ serviceId: foreignService.id, quantity: "1", isExternal: false }] }),
    ).toMatchObject(notFound);
    expect(ok(await s.quote())).toMatchObject({ total: 6_000_000, seasonId: null, dateSeasonId: null });
  });

  it("PQ-05 (SEC-11): needs a session and bookings.view; every default role has it", async () => {
    const s = await scenario();
    const roleId = ok(
      await s.call(userSpecs.createRole, { name: "بلا عرض", permissionKeys: ["expenses.view"] }, s.owner.token),
    ).id;
    const noView = await addStaff(handle, s.owner.actor, "noview", [roleId]);

    expect(await callSpec(handle, pricingSpecs.quote as AnySpec, undefined, {})).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(await s.quote({}, noView.token)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    for (const token of [s.owner.token, s.manager.token, s.reception.token, s.accountant.token]) {
      expect(ok(await s.quote({}, token)).total).toBe(6_000_000);
    }
  });

  it("PQ-06 (SEC-20): malformed input is refused before any reading", async () => {
    const s = await scenario();
    const invalid = { ok: false, error: { code: "VALIDATION_ERROR" } };
    const many = Array.from({ length: 101 }, () => ({ serviceId: s.S.BAND, quantity: "1", isExternal: false }));
    for (const input of [
      { eventDate: "2027-02-30" },
      { guests: "0" },
      { guests: "100001" },
      { guests: "2.5" },
      { discountAmount: "-5" },
      { discountAmount: "1.005" },
      { packageId: "not-a-uuid" },
      { slotKind: "night" },
      { items: many },
      { items: [{ serviceId: s.S.BAND, quantity: "0", isExternal: false }] },
    ]) {
      expect(await s.quote(input)).toMatchObject(invalid);
    }
    // Arabic digits, as typed.
    expect(ok(await s.quote({ guests: "٢٠١" })).total).toBe(6_015_000);
  });

  it("PQ-07: a quote writes nothing — no audit row, no change to the package", async () => {
    const s = await scenario();
    const before = await auditActions(handle);
    const version = (await getPackage(db, s.owner.actor, s.gold)).package.version;
    await s.quote();
    await s.quote({ removedServiceIds: [s.S.ZAFFA] });
    expect(await auditActions(handle)).toEqual(before);
    expect((await getPackage(db, s.owner.actor, s.gold)).package.version).toBe(version);
  });
});
