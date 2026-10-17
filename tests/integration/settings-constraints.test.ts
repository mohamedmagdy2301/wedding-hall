import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cancellationTiers, paymentMethods, seasons, spaceSlots, spaces, venues } from "@/db/schema";
import { VENUE_DEFAULTS } from "@/modules/settings/setup";
import { connectTestDb, truncateAll } from "./helpers/db";
import { PG_CHECK_VIOLATION, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from "./helpers/pg-error";

/** Database-level guarantees of migration 0003 (the services add their own checks on top). */
describe("settings constraints (migration 0003)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  let venueId: string;

  beforeEach(async () => {
    await truncateAll(handle);
    const [venue] = await db
      .insert(venues)
      .values({ name: "قاعة", ...VENUE_DEFAULTS })
      .returning({ id: venues.id });
    venueId = venue.id;
  });
  afterAll(() => handle.close());

  const season = (name: string, startDate: string, endDate: string, isActive = true) =>
    db.insert(seasons).values({ venueId, name, startDate, endDate, isActive }).returning({ id: seasons.id });
  const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, pgErrorCode);

  describe("seasons_no_overlap (BR-31)", () => {
    it("rejects a full and a partial overlap", async () => {
      await season("الصيف", "2026-06-01", "2026-08-31");
      expect(await codeOf(season("داخل الصيف", "2026-07-01", "2026-07-10"))).toBe(PG_EXCLUSION_VIOLATION);
      expect(await codeOf(season("نهاية الصيف", "2026-08-15", "2026-09-15"))).toBe(PG_EXCLUSION_VIOLATION);
    });

    it("treats the shared boundary day as an overlap (inclusive ranges) and accepts adjacent seasons", async () => {
      await season("الصيف", "2026-06-01", "2026-08-31");
      expect(await codeOf(season("الخريف", "2026-08-31", "2026-10-31"))).toBe(PG_EXCLUSION_VIOLATION);
      expect(await codeOf(season("الخريف", "2026-09-01", "2026-10-31"))).toBeUndefined();
    });

    it("ignores inactive seasons, and refuses to reactivate an overlapping one", async () => {
      await season("الصيف", "2026-06-01", "2026-08-31");
      const [old] = await season("صيف قديم", "2026-07-01", "2026-07-31", false);
      const reactivate = db.update(seasons).set({ isActive: true }).where(eq(seasons.id, old.id));
      expect(await codeOf(reactivate)).toBe(PG_EXCLUSION_VIOLATION);
    });

    it("rejects end before start", async () => {
      expect(await codeOf(season("مقلوب", "2026-08-31", "2026-06-01"))).toBe(PG_CHECK_VIOLATION);
    });
  });

  it("names are unique per venue ignoring case, including inactive rows (D-72)", async () => {
    await db.insert(paymentMethods).values({ venueId, name: "Cash", isActive: false });
    const dup = db.insert(paymentMethods).values({ venueId, name: "cash" });
    expect(await codeOf(dup)).toBe(PG_UNIQUE_VIOLATION);
  });

  it("rejects untrimmed or empty names", async () => {
    expect(await codeOf(db.insert(paymentMethods).values({ venueId, name: " نقدي" }))).toBe(PG_CHECK_VIOLATION);
    expect(await codeOf(db.insert(paymentMethods).values({ venueId, name: "" }))).toBe(PG_CHECK_VIOLATION);
  });

  describe("space_slots (BR-01, D-69)", () => {
    let spaceId: string;
    beforeEach(async () => {
      const [space] = await db.insert(spaces).values({ venueId, name: "القاعة الكبرى" }).returning({ id: spaces.id });
      spaceId = space.id;
    });
    const slot = (kind: "day" | "evening", startTime: string, endTime: string) =>
      db.insert(spaceSlots).values({ venueId, spaceId, kind, startTime, endTime });

    it("lets only the evening slot cross midnight", async () => {
      expect(await codeOf(slot("evening", "19:00", "01:00"))).toBeUndefined();
      expect(await codeOf(slot("day", "22:00", "02:00"))).toBe(PG_CHECK_VIOLATION);
    });

    it("rejects a zero-length slot and a second slot of the same kind", async () => {
      expect(await codeOf(slot("evening", "19:00", "19:00"))).toBe(PG_CHECK_VIOLATION);
      await slot("day", "12:00", "17:00");
      expect(await codeOf(slot("day", "13:00", "17:00"))).toBe(PG_UNIQUE_VIOLATION);
    });
  });

  it("cancellation tiers: one per day count, refund within 0–100% (BR-77)", async () => {
    await db.insert(cancellationTiers).values({ venueId, minDaysBefore: 30, refundBps: 5000 });
    expect(await codeOf(db.insert(cancellationTiers).values({ venueId, minDaysBefore: 30, refundBps: 0 }))).toBe(
      PG_UNIQUE_VIOLATION,
    );
    expect(await codeOf(db.insert(cancellationTiers).values({ venueId, minDaysBefore: 60, refundBps: 10001 }))).toBe(
      PG_CHECK_VIOLATION,
    );
  });

  it("space capacity is optional and positive (BR-05)", async () => {
    expect(await codeOf(db.insert(spaces).values({ venueId, name: "روف", capacityMax: 0 }))).toBe(PG_CHECK_VIOLATION);
    expect(await codeOf(db.insert(spaces).values({ venueId, name: "حديقة", capacityMax: null }))).toBeUndefined();
  });
});
