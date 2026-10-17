import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { packageItems, packagePrices, packages, seasons, services, spaces, venues } from "@/db/schema";
import { VENUE_DEFAULTS } from "@/modules/settings/setup";
import { connectTestDb, truncateAll } from "./helpers/db";
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from "./helpers/pg-error";

const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** Database-level guarantees of migration 0004 (the services add their own checks on top). */
describe("catalog constraints (migration 0004)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  let venueId: string;
  let spaceA: string;
  let spaceB: string;

  beforeEach(async () => {
    await truncateAll(handle);
    const [venue] = await db
      .insert(venues)
      .values({ name: "قاعة", ...VENUE_DEFAULTS })
      .returning({ id: venues.id });
    venueId = venue.id;
    const rows = await db
      .insert(spaces)
      .values([
        { venueId, name: "الكبرى" },
        { venueId, name: "الروف" },
      ])
      .returning({ id: spaces.id });
    [spaceA, spaceB] = rows.map((r) => r.id);
  });
  afterAll(() => handle.close());

  const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, pgErrorCode);
  const service = (values: Partial<typeof services.$inferInsert> = {}) =>
    db
      .insert(services)
      .values({ venueId, name: "دي جي", category: "show", pricingType: "fixed", unitPrice: 100000, ...values })
      .returning({ id: services.id });
  const pkg = (values: Partial<typeof packages.$inferInsert> = {}) =>
    db
      .insert(packages)
      .values({ venueId, spaceId: spaceA, name: "الفضي", baseGuests: 200, extraGuestPrice: 15000, ...values })
      .returning({ id: packages.id });

  describe("names (D-76)", () => {
    it("service names are unique per venue ignoring case, including inactive ones", async () => {
      await service({ name: "DJ", isActive: false });
      expect(await codeOf(service({ name: "dj" }))).toBe(PG_UNIQUE_VIOLATION);
    });

    it("package names are unique within a space, and may repeat across spaces", async () => {
      await pkg({ name: "Silver", isActive: false });
      expect(await codeOf(pkg({ name: "silver" }))).toBe(PG_UNIQUE_VIOLATION);
      expect(await codeOf(pkg({ name: "silver", spaceId: spaceB }))).toBeUndefined();
    });

    it("rejects untrimmed or too long names", async () => {
      expect(await codeOf(service({ name: " دي جي" }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(pkg({ name: "ب".repeat(81) }))).toBe(PG_CHECK_VIOLATION);
    });
  });

  describe("services (BR-34, D-39, D-79)", () => {
    it("allows a zero price and rejects a negative one", async () => {
      expect(await codeOf(service({ unitPrice: 0 }))).toBeUndefined();
      expect(await codeOf(service({ name: "سالب", unitPrice: -1 }))).toBe(PG_CHECK_VIOLATION);
    });

    it("an external fee needs allow_external, and is never negative", async () => {
      expect(await codeOf(service({ externalFee: 50000, allowExternal: false }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(service({ externalFee: -1, allowExternal: true }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(service({ externalFee: 50000, allowExternal: true }))).toBeUndefined();
    });
  });

  describe("packages (D-79)", () => {
    it("allows zero base guests, and rejects out-of-range values", async () => {
      expect(await codeOf(pkg({ baseGuests: 0 }))).toBeUndefined();
      expect(await codeOf(pkg({ name: "ب", baseGuests: 100001 }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(pkg({ name: "ج", extraGuestPrice: -1 }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(pkg({ name: "د", description: "ن".repeat(501) }))).toBe(PG_CHECK_VIOLATION);
    });
  });

  describe("package_prices (BR-30)", () => {
    it("one regular price per slot: season_id null is NOT DISTINCT", async () => {
      const [p] = await pkg();
      await db.insert(packagePrices).values({ venueId, packageId: p.id, slotKind: "evening", price: 5000000 });
      const dup = db.insert(packagePrices).values({ venueId, packageId: p.id, slotKind: "evening", price: 6000000 });
      expect(await codeOf(dup)).toBe(PG_UNIQUE_VIOLATION);
    });

    it("one price per slot and season, and a positive price", async () => {
      const [p] = await pkg();
      const [s] = await db
        .insert(seasons)
        .values({ venueId, name: "الصيف", startDate: "2027-06-01", endDate: "2027-08-31" })
        .returning({ id: seasons.id });
      const row = { venueId, packageId: p.id, slotKind: "day" as const, seasonId: s.id, price: 3000000 };
      await db.insert(packagePrices).values(row);
      expect(await codeOf(db.insert(packagePrices).values(row))).toBe(PG_UNIQUE_VIOLATION);
      const zero = db.insert(packagePrices).values({ ...row, slotKind: "evening", price: 0 });
      expect(await codeOf(zero)).toBe(PG_CHECK_VIOLATION);
    });
  });

  describe("package_items (BR-33, D-80)", () => {
    it("a service appears once per package; quantity 1–10000", async () => {
      const [p] = await pkg();
      const [s] = await service();
      const item = { venueId, packageId: p.id, serviceId: s.id };
      await db.insert(packageItems).values(item);
      expect(await codeOf(db.insert(packageItems).values(item))).toBe(PG_UNIQUE_VIOLATION);
      const [other] = await service({ name: "تصوير", pricingType: "per_unit" });
      const bad = db.insert(packageItems).values({ ...item, serviceId: other.id, quantity: 0 });
      expect(await codeOf(bad)).toBe(PG_CHECK_VIOLATION);
    });

    it("a removal credit only on a removable item", async () => {
      const [p] = await pkg();
      const [s] = await service();
      const item = { venueId, packageId: p.id, serviceId: s.id, removalCredit: 20000 };
      expect(await codeOf(db.insert(packageItems).values({ ...item, removable: false }))).toBe(PG_CHECK_VIOLATION);
      expect(await codeOf(db.insert(packageItems).values({ ...item, removable: true }))).toBeUndefined();
    });
  });

  it("services and packages are never deleted (D-82)", async () => {
    const [s] = await service();
    const [p] = await pkg();
    expect(await codeOf(db.delete(services).where(eq(services.id, s.id)))).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(await codeOf(db.delete(packages).where(eq(packages.id, p.id)))).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });
});
