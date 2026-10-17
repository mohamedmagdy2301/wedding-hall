import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { auditLogs, packageItems, packagePrices, packages, seasons, services, spaces, venues } from "@/db/schema";
import { listServices } from "@/modules/catalog/services";
import { getPackage, listPackages } from "@/modules/packages/service";
import { VENUE_DEFAULTS } from "@/modules/settings/setup";
import { catalogSpecs } from "@/server/specs/catalog";
import type { ProtectedSpec } from "@/server/specs/define";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { connectTestDb, truncateAll } from "./helpers/db";
import { addStaff, auditActions, callSpec, setUpVenueWithOwner } from "./helpers/fixtures";

const slots = { day: { start: "12:00", end: "17:00" }, evening: { start: "18:00", end: "23:00" } };

const dj = {
  name: "دي جي",
  category: "show",
  pricingType: "fixed",
  unitPrice: "3000",
  allowExternal: true,
  externalFee: "500",
};
const photos = {
  name: "تصوير",
  category: "service",
  pricingType: "per_unit",
  unitPrice: "1500",
  allowExternal: false,
  externalFee: "",
};

type AnySpec = ProtectedSpec<z.ZodType, unknown>;
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; rule?: string } };

const ok = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

describe("catalog: services and packages (phase 3)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  /** Owner, a manager (catalog.manage), a receptionist; one space, a season and two services. */
  async function scenario() {
    const base = await setUpVenueWithOwner(handle);
    const manager = await addStaff(handle, base.owner.actor, "manager", [base.roleId("مدير")]);
    const reception = await addStaff(handle, base.owner.actor, "reception", [base.roleId("استقبال/حجوزات")]);
    const call = (spec: unknown, input: unknown, token = manager.token) =>
      callSpec(handle, spec as AnySpec, token, input) as Promise<Result<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const space = ok(await call(spaceSpecs.createSpace, { name: "القاعة الكبرى", capacityMax: "300", ...slots })) as {
      id: string;
    };
    const season = ok(
      await call(settingsSpecs.createSeason, { name: "الصيف", startDate: "2027-06-01", endDate: "2027-08-31" }),
    ) as { id: string };
    const djId = (ok(await call(catalogSpecs.createService, dj)) as { id: string }).id;
    const photosId = (ok(await call(catalogSpecs.createService, photos)) as { id: string }).id;
    return { ...base, manager, reception, call, spaceId: space.id, seasonId: season.id, djId, photosId };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const packageInput = (s: Scenario, extra: Record<string, unknown> = {}) => ({
    spaceId: s.spaceId,
    name: "الباكيج الفضي",
    description: "",
    baseGuests: "200",
    extraGuestPrice: "150",
    isActive: true,
    prices: [
      { slotKind: "evening", seasonId: null, price: "50000" },
      { slotKind: "evening", seasonId: s.seasonId, price: "60000" },
    ],
    items: [
      { serviceId: s.djId, quantity: "1", removable: true, removalCredit: "1000" },
      { serviceId: s.photosId, quantity: "2", removable: false, removalCredit: "" },
    ],
    ...extra,
  });

  /** The fields of an update, from the current package detail plus overrides. */
  async function updateInput(s: Scenario, packageId: string, extra: Record<string, unknown> = {}) {
    const { package: p } = await getPackage(db, s.owner.actor, packageId);
    return {
      packageId,
      version: p.version,
      name: p.name,
      description: p.description ?? "",
      baseGuests: p.baseGuests,
      extraGuestPrice: String(p.extraGuestPrice / 100),
      isActive: p.isActive,
      prices: p.prices.map((x) => ({ ...x, price: String(x.price / 100) })),
      items: p.items.map((i) => ({ ...i, removalCredit: String(i.removalCredit / 100) })),
      ...extra,
    };
  }

  const packageRow = async (id: string) => (await db.select().from(packages).where(eq(packages.id, id)))[0];
  const priceRows = (id: string) => db.select().from(packagePrices).where(eq(packagePrices.packageId, id));
  const itemRows = (id: string) => db.select().from(packageItems).where(eq(packageItems.packageId, id));

  describe("SEC-11: every operation needs catalog.manage and a session", () => {
    it("the receptionist and an anonymous call are refused; the manager may", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      // In an order the manager can run them all: the update bumps the version to 2.
      const ops: [unknown, unknown][] = [
        [catalogSpecs.createService, { ...dj, name: "زفة" }],
        [catalogSpecs.updateService, { serviceId: s.djId, ...dj }],
        [catalogSpecs.createPackage, packageInput(s, { name: "الذهبي" })],
        [catalogSpecs.updatePackage, await updateInput(s, created.id)],
        [catalogSpecs.setPackageActive, { packageId: created.id, version: 2, active: false }],
        [catalogSpecs.setServiceActive, { serviceId: s.djId, active: false }],
      ];
      const before = (await auditActions(handle)).length;
      for (const [spec, input] of ops) {
        expect(await s.call(spec, input, s.reception.token)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(await callSpec(handle, spec as AnySpec, undefined, input)).toMatchObject({
          ok: false,
          error: { code: "UNAUTHENTICATED" },
        });
      }
      expect((await auditActions(handle)).length).toBe(before);
      for (const [spec, input] of ops) expect(await s.call(spec, input)).toMatchObject({ ok: true });
    });
  });

  describe("services (BR-34, D-39, D-76, D-80)", () => {
    it("are stored in piasters, and the external fee only when external providers are allowed", async () => {
      const s = await scenario();
      const id = (
        ok(await s.call(catalogSpecs.createService, { ...photos, name: "ورد", externalFee: "700" })) as {
          id: string;
        }
      ).id;
      const [row] = await db.select().from(services).where(eq(services.id, id));
      expect(row).toMatchObject({ unitPrice: 150000, externalFee: 0, allowExternal: false });
      const [djRow] = await db.select().from(services).where(eq(services.id, s.djId));
      expect(djRow).toMatchObject({ unitPrice: 300000, externalFee: 50000, allowExternal: true });
    });

    it("D-76: a duplicate name is refused, and suggests reactivating an inactive one", async () => {
      const s = await scenario();
      expect(await s.call(catalogSpecs.createService, { ...dj, name: "دي جي" })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { name: expect.any(String) } },
      });
      ok(await s.call(catalogSpecs.setServiceActive, { serviceId: s.djId, active: false }));
      const result = await s.call(catalogSpecs.createService, { ...photos, name: "دي جي" });
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(JSON.stringify(result)).toContain("فعّله");
    });

    it("D-80: the pricing type is fixed while a package includes the service", async () => {
      const s = await scenario();
      ok(await s.call(catalogSpecs.createPackage, packageInput(s)));
      expect(
        await s.call(catalogSpecs.updateService, { serviceId: s.photosId, ...photos, pricingType: "per_guest" }),
      ).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-80" } });
      // Price, name and category still change freely.
      ok(await s.call(catalogSpecs.updateService, { serviceId: s.photosId, ...photos, unitPrice: "1750" }));
      // A service in no package may change its type.
      const free = (ok(await s.call(catalogSpecs.createService, { ...dj, name: "بوفيه" })) as { id: string }).id;
      ok(await s.call(catalogSpecs.updateService, { serviceId: free, ...dj, name: "بوفيه", pricingType: "per_guest" }));
    });

    it("D-80: a deactivated service stays in its packages, with the count shown; it is not added anew", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      ok(await s.call(catalogSpecs.setServiceActive, { serviceId: s.djId, active: false }));
      expect((await itemRows(created.id)).map((i) => i.serviceId)).toContain(s.djId);
      const listed = await listServices(db, s.manager.actor);
      expect(listed.find((x) => x.id === s.djId)).toMatchObject({ isActive: false, packageCount: 1 });
      // Kept on save…
      ok(await s.call(catalogSpecs.updatePackage, await updateInput(s, created.id, { name: "الفضي" })));
      // …but not added to another package.
      expect(await s.call(catalogSpecs.createPackage, packageInput(s, { name: "الذهبي" }))).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-80" },
      });
    });
  });

  describe("phase 3 acceptance: no active package without a regular price (BR-30, D-56, D-78)", () => {
    const noRegular = (s: Scenario) => [{ slotKind: "evening", seasonId: s.seasonId, price: "60000" }];

    it("BR-30: creating an active package without a regular price is refused, with no audit row", async () => {
      const s = await scenario();
      const before = await auditActions(handle);
      for (const prices of [[], noRegular(s)]) {
        expect(await s.call(catalogSpecs.createPackage, packageInput(s, { prices }))).toMatchObject({
          ok: false,
          error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" },
        });
      }
      expect(await auditActions(handle)).toEqual(before);
      expect(await db.select().from(packages)).toEqual([]);
    });

    it("D-78: an inactive draft may be saved without prices, and is activated only once it has a regular price", async () => {
      const s = await scenario();
      const draft = ok(
        await s.call(catalogSpecs.createPackage, packageInput(s, { isActive: false, prices: [], items: [] })),
      ) as { id: string; version: number };
      expect(
        await s.call(catalogSpecs.setPackageActive, { packageId: draft.id, version: draft.version, active: true }),
      ).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" } });
      expect(
        await s.call(catalogSpecs.updatePackage, await updateInput(s, draft.id, { isActive: true })),
      ).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" } });
      const priced = ok(
        await s.call(
          catalogSpecs.updatePackage,
          await updateInput(s, draft.id, { prices: [{ slotKind: "day", seasonId: null, price: "30000" }] }),
        ),
      ) as { version: number };
      ok(await s.call(catalogSpecs.setPackageActive, { packageId: draft.id, version: priced.version, active: true }));
      expect(await packageRow(draft.id)).toMatchObject({ isActive: true, version: 3 });
    });

    it("BR-30: an update that removes the last regular price of an active package is refused", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      expect(await s.call(catalogSpecs.updatePackage, await updateInput(s, created.id, { prices: [] }))).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" },
      });
      expect(await priceRows(created.id)).toHaveLength(2);
    });

    it("D-81: a concurrent price removal and activation never leave an active package without a regular price", async () => {
      const s = await scenario();
      for (let round = 0; round < 5; round++) {
        const draft = ok(
          await s.call(
            catalogSpecs.createPackage,
            packageInput(s, { name: `مسودة ${round}`, isActive: false, prices: [packageInput(s).prices[0]] }),
          ),
        ) as { id: string; version: number };
        const removePrices = await updateInput(s, draft.id, { prices: [] });
        const results = await Promise.all([
          s.call(catalogSpecs.updatePackage, removePrices),
          s.call(catalogSpecs.setPackageActive, { packageId: draft.id, version: draft.version, active: true }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION" } });
        const row = await packageRow(draft.id);
        const regular = (await priceRows(draft.id)).filter((p) => p.seasonId === null);
        expect(row.isActive && regular.length === 0).toBe(false);
      }
    });
  });

  describe("prices per slot × season (BR-30, D-56, D-78)", () => {
    it("D-78: a season price needs a regular price for the same slot", async () => {
      const s = await scenario();
      const prices = [
        { slotKind: "evening", seasonId: null, price: "50000" },
        { slotKind: "day", seasonId: s.seasonId, price: "40000" },
      ];
      expect(await s.call(catalogSpecs.createPackage, packageInput(s, { prices }))).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" },
      });
    });

    it("D-78: an inactive season keeps its prices, but gets no new or changed one", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      ok(await s.call(settingsSpecs.setSeasonActive, { seasonId: s.seasonId, active: false }));
      // Saving untouched keeps the inactive season's price.
      ok(await s.call(catalogSpecs.updatePackage, await updateInput(s, created.id, { name: "الفضي ٢" })));
      expect(await priceRows(created.id)).toHaveLength(2);
      // Changing it is refused.
      const changed = await updateInput(s, created.id);
      changed.prices = changed.prices.map((p) => (p.seasonId ? { ...p, price: "65000" } : p));
      expect(await s.call(catalogSpecs.updatePackage, changed)).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "D-78" },
      });
      // Removing it is allowed.
      const removed = await updateInput(s, created.id);
      removed.prices = removed.prices.filter((p) => p.seasonId === null);
      ok(await s.call(catalogSpecs.updatePackage, removed));
      expect(await priceRows(created.id)).toHaveLength(1);
    });

    it("D-56: the list shows the bookable slots (those with a regular price)", async () => {
      const s = await scenario();
      ok(await s.call(catalogSpecs.createPackage, packageInput(s)));
      const [listed] = await listPackages(db, s.manager.actor);
      expect(listed).toMatchObject({ spaceName: "القاعة الكبرى", bookableSlots: ["evening"], itemCount: 2 });
    });
  });

  describe("included services (BR-33, D-79, D-80)", () => {
    it("quantity only for per-unit services; a removal credit only on removable items", async () => {
      const s = await scenario();
      const items = (djQuantity: string) => [{ serviceId: s.djId, quantity: djQuantity, removable: false }];
      expect(await s.call(catalogSpecs.createPackage, packageInput(s, { items: items("2") }))).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { items: expect.stringContaining("بالعدد") } },
      });
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      const rows = await itemRows(created.id);
      expect(rows.find((r) => r.serviceId === s.djId)).toMatchObject({ removable: true, removalCredit: 100000 });
      expect(rows.find((r) => r.serviceId === s.photosId)).toMatchObject({ quantity: 2, removalCredit: 0 });
    });

    it("D-81: unchanged prices and items keep their ids; removed ones are deleted", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      const [regularBefore] = (await priceRows(created.id)).filter((p) => p.seasonId === null);
      const djBefore = (await itemRows(created.id)).find((i) => i.serviceId === s.djId);
      const input = await updateInput(s, created.id);
      input.items = input.items.filter((i) => i.serviceId === s.djId);
      input.prices = input.prices.map((p) => (p.seasonId ? { ...p, price: "70000" } : p));
      ok(await s.call(catalogSpecs.updatePackage, input));
      const prices = await priceRows(created.id);
      expect(prices.find((p) => p.seasonId === null)?.id).toBe(regularBefore.id);
      expect(prices.find((p) => p.seasonId !== null)?.price).toBe(7000000);
      expect((await itemRows(created.id)).map((i) => i.id)).toEqual([djBefore?.id]);
    });
  });

  describe("D-81: optimistic locking on the package with its prices and items", () => {
    it("a save on a stale version is refused with CONCURRENT_MODIFICATION and changes nothing", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      // Both pages are opened on version 1.
      const mine = await updateInput(s, created.id, { prices: [{ slotKind: "day", seasonId: null, price: "1" }] });
      const theirs = await updateInput(s, created.id, { name: "الفضي الجديد" });
      ok(await s.call(catalogSpecs.updatePackage, theirs, s.owner.token));
      const auditBefore = await auditActions(handle);
      const result = await s.call(catalogSpecs.updatePackage, mine);
      expect(result).toMatchObject({ ok: false, error: { code: "CONCURRENT_MODIFICATION" } });
      expect(JSON.stringify(result)).toContain("الباكيج اتعدّل من شخص تاني. حدّث الصفحة وراجع التعديلات");
      expect(await packageRow(created.id)).toMatchObject({ name: "الفضي الجديد", version: 2 });
      expect((await priceRows(created.id)).map((p) => p.price).sort()).toEqual([5000000, 6000000]);
      expect(await itemRows(created.id)).toHaveLength(2);
      expect(await auditActions(handle)).toEqual(auditBefore);
    });

    it("activation and deactivation bump the version, so a page opened before them is stale", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      const page = await updateInput(s, created.id, { name: "اسم جديد" });
      ok(await s.call(catalogSpecs.setPackageActive, { packageId: created.id, version: 1, active: false }));
      expect(await s.call(catalogSpecs.updatePackage, page)).toMatchObject({
        ok: false,
        error: { code: "CONCURRENT_MODIFICATION" },
      });
      expect(
        await s.call(catalogSpecs.setPackageActive, { packageId: created.id, version: 1, active: true }),
      ).toMatchObject({ ok: false, error: { code: "CONCURRENT_MODIFICATION" } });
      expect(await packageRow(created.id)).toMatchObject({ isActive: false, version: 2 });
    });

    it("two saves in parallel on the same version: exactly one succeeds", async () => {
      const s = await scenario();
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      const a = await updateInput(s, created.id, { name: "أ" });
      const b = await updateInput(s, created.id, { name: "ب" });
      const results = await Promise.all([
        s.call(catalogSpecs.updatePackage, a),
        s.call(catalogSpecs.updatePackage, b, s.owner.token),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION" } });
      expect((await packageRow(created.id)).version).toBe(2);
    });
  });

  describe("package and space (D-76, D-77)", () => {
    it("D-77: no package on an inactive space; the space never changes on update", async () => {
      const s = await scenario();
      const other = ok(await s.call(spaceSpecs.createSpace, { name: "الروف", capacityMax: "", ...slots })) as {
        id: string;
      };
      ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: other.id, active: false }));
      expect(await s.call(catalogSpecs.createPackage, packageInput(s, { spaceId: other.id }))).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-06" },
      });
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      ok(await s.call(catalogSpecs.updatePackage, { ...(await updateInput(s, created.id)), spaceId: other.id }));
      expect((await packageRow(created.id)).spaceId).toBe(s.spaceId);
    });

    it("D-76: the same name is allowed in another space but not twice in one", async () => {
      const s = await scenario();
      const other = ok(await s.call(spaceSpecs.createSpace, { name: "الروف", capacityMax: "", ...slots })) as {
        id: string;
      };
      ok(await s.call(catalogSpecs.createPackage, packageInput(s)));
      ok(await s.call(catalogSpecs.createPackage, packageInput(s, { spaceId: other.id })));
      expect(await s.call(catalogSpecs.createPackage, packageInput(s, { name: "الباكيج الفضي" }))).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { name: expect.any(String) } },
      });
    });

    it("a failed save is atomic: a rename conflict leaves the prices and items as they were", async () => {
      const s = await scenario();
      ok(await s.call(catalogSpecs.createPackage, packageInput(s, { name: "الذهبي" })));
      const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
      const input = await updateInput(s, created.id, {
        name: "الذهبي",
        prices: [{ slotKind: "day", seasonId: null, price: "1" }],
        items: [],
      });
      expect(await s.call(catalogSpecs.updatePackage, input)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
      expect(await priceRows(created.id)).toHaveLength(2);
      expect(await itemRows(created.id)).toHaveLength(2);
      expect(await packageRow(created.id)).toMatchObject({ name: "الباكيج الفضي", version: 1 });
    });
  });

  it("cannot use another venue's space, season or service (venue_id scoping)", async () => {
    const s = await scenario();
    const [other] = await db
      .insert(venues)
      .values({ name: "منشأة أخرى", ...VENUE_DEFAULTS })
      .returning({ id: venues.id });
    const [foreignSpace] = await db
      .insert(spaces)
      .values({ venueId: other.id, name: "قاعة" })
      .returning({ id: spaces.id });
    const [foreignSeason] = await db
      .insert(seasons)
      .values({ venueId: other.id, name: "موسم", startDate: "2027-01-01", endDate: "2027-01-31" })
      .returning({ id: seasons.id });
    const [foreignService] = await db
      .insert(services)
      .values({ venueId: other.id, name: "خدمة", category: "service", pricingType: "fixed", unitPrice: 1 })
      .returning({ id: services.id });
    const notFound = { ok: false, error: { code: "NOT_FOUND" } };
    expect(await s.call(catalogSpecs.createPackage, packageInput(s, { spaceId: foreignSpace.id }))).toMatchObject(
      notFound,
    );
    const foreignPrice = [...packageInput(s).prices, { slotKind: "evening", seasonId: foreignSeason.id, price: "1" }];
    expect(await s.call(catalogSpecs.createPackage, packageInput(s, { prices: foreignPrice }))).toMatchObject(notFound);
    const foreignItem = [{ serviceId: foreignService.id, quantity: "1", removable: false }];
    expect(await s.call(catalogSpecs.createPackage, packageInput(s, { items: foreignItem }))).toMatchObject(notFound);
    expect(await s.call(catalogSpecs.setServiceActive, { serviceId: foreignService.id, active: false })).toMatchObject(
      notFound,
    );
  });

  it("the audit log records each operation with readable before/after", async () => {
    const s = await scenario();
    const created = ok(await s.call(catalogSpecs.createPackage, packageInput(s))) as { id: string };
    ok(await s.call(catalogSpecs.updatePackage, await updateInput(s, created.id, { baseGuests: "250" })));
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "package"), eq(auditLogs.entityId, created.id)));
    expect(rows.map((r) => r.action).sort()).toEqual(["packages.create", "packages.update"]);
    const update = rows.find((r) => r.action === "packages.update");
    expect(update?.actorId).toBe(s.manager.actor.userId);
    expect(update?.before).toMatchObject({
      baseGuests: 200,
      prices: expect.arrayContaining([{ slotKind: "evening", season: "الصيف", price: 6000000 }]),
      items: expect.arrayContaining([{ service: "دي جي", quantity: 1, removable: true, removalCredit: 100000 }]),
    });
    expect(update?.after).toMatchObject({ baseGuests: 250 });
    expect(await auditActions(handle)).toEqual(expect.arrayContaining(["services.create", "packages.create"]));
  });
});
