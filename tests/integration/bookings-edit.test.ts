import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs, bookingCounters, bookingItems, bookings, customers, spaces } from "@/db/schema";
import { addMs } from "@/lib/time";
import { bookingSpecs } from "@/server/specs/bookings";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { confirmBooking, SLOTS } from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";
import { bookingScenario, type Failure, NOW, HOUR, ok, failed } from "./helpers/booking-scenario";

/**
 * PHASE5_PLAN §9.5 (B-08 / B-22, B-09, B-17, B-21, C-07, D-113, C-08): tentative bookings through the real action
 * pipeline (session → Zod → permission → service), on the shared scenario.
 */
describe("bookings: editing and extending (phase 5)", () => {
  const handle = connectTestDb();
  const second = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(async () => {
    await handle.close();
    await second.close();
  });

  const scenario = () => bookingScenario(handle);
  const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];

  it("B-08 / B-22: editing a tentative booking re-prices when needed, keeps its expiry, takes the current buffer and refuses a stale version", async () => {
    const s = await scenario();
    const created = await s.create({ packageId: s.gold, guests: "200" });
    const before = await row(created.id);
    expect(before.total).toBe(6_000_000);

    ok(await s.call(settingsSpecs.updateTiming, { bufferMinutes: "90", tentativeHoldHours: "48" }, s.owner.token));
    const edit = (extra: Record<string, unknown>, version: number) =>
      s.call(bookingSpecs.updateTentative, {
        ...s.minimal({ packageId: s.gold, guests: "200", customer: { customerId: before.customerId } }),
        bookingId: created.id,
        version,
        ...extra,
      });

    // Only the notes: no re-pricing, but the buffer is the current one (D-110).
    const v2 = ok(await edit({ notes: "اتصل بعد العيد" }, 1)).version;
    let b = await row(created.id);
    expect(b.blockedUntil.getTime() - b.endsAt.getTime()).toBe(90 * 60_000);
    expect(b.total).toBe(6_000_000);
    expect(b.tentativeExpiresAt).toEqual(before.tentativeExpiresAt);

    // Into the summer season: re-priced, lines replaced.
    const v3 = ok(await edit({ eventDate: "2027-07-10", removedServiceIds: [s.S.DJ] }, v2)).version;
    b = await row(created.id);
    expect(b.total).toBe(7_500_000 - 300_000);
    expect(b.seasonId).toBe(s.summer);
    const lines = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, created.id));
    expect(lines.filter((l) => l.isRemoved).map((l) => l.serviceId)).toEqual([s.S.DJ]);
    expect(b.tentativeExpiresAt).toEqual(before.tentativeExpiresAt);

    expect(failed(await edit({ notes: "قديم" }, v2)).code).toBe("CONCURRENT_MODIFICATION");
    // Without a package the price group empties (D-103).
    ok(await edit({ packageId: "", guests: "", eventDate: "2027-07-10" }, v3));
    b = await row(created.id);
    expect(b.total).toBeNull();
    expect(await db.select().from(bookingItems).where(eq(bookingItems.bookingId, created.id))).toHaveLength(0);

    // A confirmed booking is not edited this way.
    const other = await s.create({ eventDate: "2027-02-01", packageId: s.gold, guests: "200", eventTypeId: s.wedding });
    await confirmBooking(handle, s, other.id);
    const confirmed = await row(other.id);
    expect(
      failed(
        await s.call(bookingSpecs.updateTentative, {
          ...s.minimal({ eventDate: "2027-02-01", customer: { customerId: confirmed.customerId } }),
          bookingId: other.id,
          version: confirmed.version,
        }),
      ).rule,
    ).toBe("D-101");
  });

  it("B-09: updateDetails changes non-financial data only and refuses a cancelled booking", async () => {
    const s = await scenario();
    const created = await s.create({ packageId: s.gold, guests: "200" });
    const b = await row(created.id);
    const result = ok(
      await s.call(bookingSpecs.updateDetails, {
        bookingId: created.id,
        version: 1,
        customerId: b.customerId,
        eventTypeId: s.wedding,
        groomName: "أحمد",
        brideName: "منى",
        notes: "",
      }),
    );
    expect(result.version).toBe(2);
    const after = await row(created.id);
    expect([after.groomName, after.brideName, after.eventTypeId, after.total]).toEqual([
      "أحمد",
      "منى",
      s.wedding,
      6_000_000,
    ]);
    await db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: NOW, cancelledBy: s.ownerId, cancelReason: "اختبار" })
      .where(eq(bookings.id, created.id));
    expect(
      failed(
        await s.call(bookingSpecs.updateDetails, {
          bookingId: created.id,
          version: 2,
          customerId: b.customerId,
          eventTypeId: "",
          groomName: "",
          brideName: "",
          notes: "",
        }),
      ).code,
    ).toBe("BUSINESS_RULE_VIOLATION");
  });

  it("B-17: changing the slot times or the buffer later does not move existing bookings (BR-10)", async () => {
    const s = await scenario();
    const created = await s.create();
    const before = await row(created.id);
    ok(await s.call(settingsSpecs.updateTiming, { bufferMinutes: "30", tentativeHoldHours: "48" }, s.owner.token));
    ok(
      await s.call(
        spaceSpecs.updateSpace,
        {
          spaceId: s.spaceA,
          name: "القاعة الكبرى",
          capacityMax: "300",
          day: SLOTS.day,
          evening: { start: "19:00", end: "23:30" },
        },
        s.manager.token,
      ),
    );
    const after = await row(created.id);
    expect([after.startsAt, after.endsAt, after.blockedUntil]).toEqual([
      before.startsAt,
      before.endsAt,
      before.blockedUntil,
    ]);
  });

  it("B-21: extending restarts the hold from now (D-101), revives an expired booking, and refuses a stale version or a confirmed booking", async () => {
    const s = await scenario();
    const created = await s.create();
    const later = addMs(NOW, 60 * HOUR); // past the 48-hour hold
    const expiredPage = ok(await s.call(bookingSpecs.get, { bookingId: created.id }, s.accountant.token, later));
    expect(expiredPage.booking.displayStatus).toBe("expired");
    const extended = ok(
      await s.call(bookingSpecs.extendTentative, { bookingId: created.id, version: 1 }, undefined, later),
    );
    expect(new Date(extended.tentativeExpiresAt)).toEqual(addMs(later, 48 * HOUR));
    const page = ok(await s.call(bookingSpecs.get, { bookingId: created.id }, s.accountant.token, later));
    expect(page.booking.displayStatus).toBe("tentative");
    expect(page.history.map((h: { action: string }) => h.action)).toEqual([
      "bookings.extend_tentative",
      "bookings.create_tentative",
    ]);
    expect(page.history[0].changes.map((c: { field: string }) => c.field)).toEqual(["tentativeExpiresAt"]);
    expect(failed(await s.call(bookingSpecs.extendTentative, { bookingId: created.id, version: 1 })).code).toBe(
      "CONCURRENT_MODIFICATION",
    );
    expect(
      failed(await s.call(bookingSpecs.extendTentative, { bookingId: created.id, version: 2 }, s.accountant.token))
        .code,
    ).toBe("FORBIDDEN");
    const other = await s.create({ eventDate: "2027-02-01", packageId: s.gold, guests: "200", eventTypeId: s.wedding });
    await confirmBooking(handle, s, other.id);
    expect(failed(await s.call(bookingSpecs.extendTentative, { bookingId: other.id, version: 2 })).rule).toBe("D-101");
  });

  it("C-07: two edits of one tentative booking on the same version at once → one succeeds", async () => {
    const s = await scenario();
    const created = await s.create();
    const b = await row(created.id);
    const edit = (notes: string) =>
      s.call(bookingSpecs.updateTentative, {
        ...s.minimal({ customer: { customerId: b.customerId }, notes }),
        bookingId: b.id,
        version: 1,
      });
    const results = await Promise.all([edit("أ"), edit("ب")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { error: Failure }).error.code)).toEqual([
      "CONCURRENT_MODIFICATION",
    ]);
  });

  it("D-113: a forced deadlock between two bookings in two different spaces is retried — both succeed, nothing doubled or lost", async () => {
    const s = await scenario();
    // After each booking row is written (its transaction holds the numbering counter), wait
    // a little, then lock the other spaces — which the other booking holds a share lock on
    // while it waits for the counter. That is a lock cycle: a real deadlock (40P01).
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_cross_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.3);
        PERFORM 1 FROM spaces WHERE venue_id = NEW.venue_id AND id <> NEW.space_id FOR UPDATE;
        RETURN NEW;
      END; $$`);
    await db.execute(
      sql`CREATE TRIGGER test_cross_lock AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION test_cross_lock()`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await Promise.all([
        s.call(bookingSpecs.createTentative, s.minimal({ customer: { name: "عميل أ", phone: "01011111111" } })),
        s.call(
          bookingSpecs.createTentative,
          s.minimal({ spaceId: s.spaceB, customer: { name: "عميل ب", phone: "01022222222" } }),
        ),
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(results.map((r) => ok(r).bookingNo).sort()).toEqual(["2026-0001", "2026-0002"]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain("transaction retried after 40P01 (attempt 2 of 3)");
    } finally {
      warn.mockRestore();
      await db.execute(sql`DROP TRIGGER test_cross_lock ON bookings`);
      await db.execute(sql`DROP FUNCTION test_cross_lock()`);
    }
    // The aborted attempt left nothing behind: two bookings, two customers, two audit rows each, no gap.
    expect(await db.select().from(bookings)).toHaveLength(2);
    expect(await db.select().from(customers)).toHaveLength(2);
    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs)).map((a) => a.action);
    expect(actions.filter((a) => a === "bookings.create_tentative")).toHaveLength(2);
    expect(actions.filter((a) => a === "customers.create")).toHaveLength(2);
    expect((await db.select().from(bookingCounters)).map((c) => c.lastNo)).toEqual([2]);
  });

  it("C-08: a booking saved while the space is being deactivated waits for it and is refused (BR-06)", async () => {
    const s = await scenario();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const deactivation = second.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM spaces WHERE id = ${s.spaceA} FOR UPDATE`);
      await tx.update(spaces).set({ isActive: false }).where(eq(spaces.id, s.spaceA));
      locked();
      await held;
    });
    await isLocked;
    const create = s.call(bookingSpecs.createTentative, s.minimal());
    const early = await Promise.race([
      create.then(() => "finished"),
      new Promise((r) => setTimeout(() => r("waiting"), 300)),
    ]);
    expect(early).toBe("waiting");
    release();
    await deactivation;
    expect(failed(await create).rule).toBe("BR-06");
    expect(await db.select().from(bookings).where(eq(bookings.spaceId, s.spaceA))).toHaveLength(0);
  });
});
