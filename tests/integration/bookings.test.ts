import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, bookingCounters, bookingItems, bookings, customers } from "@/db/schema";
import { summarize } from "@/domain/pricing";
import { addMs } from "@/lib/time";
import { createTentative } from "@/modules/bookings/service";
import { catalogSpecs } from "@/server/specs/catalog";
import { bookingSpecs, customerSpecs } from "@/server/specs/bookings";
import { pricingSpecs } from "@/server/specs/pricing";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { confirmBooking } from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";
import { depsAt } from "./helpers/fixtures";
import { bookingScenario, NOW, HOUR, ok, failed } from "./helpers/booking-scenario";

/**
 * PHASE5_PLAN §9.5 (B-01, B-02, B-03, B-04, B-05, B-06, B-07, B-10, B-11): tentative bookings through the real action
 * pipeline (session → Zod → permission → service), on the shared scenario.
 */
describe("bookings: creating (phase 5)", () => {
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

  it("B-01: a tentative booking from the minimum (D-09): status, expiry, times, number and audit (BR-03, BR-10, BR-20, BR-26)", async () => {
    const s = await scenario();
    const created = await s.create();
    expect(created.bookingNo).toBe("2026-0001");
    const b = await row(created.id);
    expect(b.status).toBe("tentative");
    expect(b.tentativeExpiresAt).toEqual(addMs(NOW, 48 * HOUR));
    expect(b.startsAt.toISOString()).toBe("2027-01-15T18:00:00.000Z");
    expect(b.endsAt.toISOString()).toBe("2027-01-15T23:00:00.000Z");
    expect(b.blockedUntil.toISOString()).toBe("2027-01-16T00:00:00.000Z");
    expect(b.packageId).toBeNull();
    expect(b.total).toBeNull();
    const [customer] = await db.select().from(customers).where(eq(customers.id, b.customerId));
    expect(customer.phone).toBe("01001234567");
    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["customers.create", "bookings.create_tentative"]));
    expect(created.warnings).toEqual({ confirmedConflicts: [], tentativeOverlaps: [] });
  });

  it("B-02: missing name or mobile, or a mobile that is not Egyptian, is refused and writes nothing", async () => {
    const s = await scenario();
    for (const customer of [
      { name: "", phone: "01001234567" },
      { name: "محمد", phone: "" },
      { name: "محمد", phone: "0223456789" },
    ]) {
      expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ customer }))).code).toBe("VALIDATION_ERROR");
    }
    expect(await db.select().from(bookings)).toHaveLength(0);
  });

  it("B-03: with a package the stored price equals pricing.quote exactly (PR-55 without the discount, D-103)", async () => {
    const s = await scenario();
    const choice = {
      packageId: s.gold,
      guests: "230",
      eventDate: "2027-07-10",
      removedServiceIds: [s.S.DJ],
      items: [
        { serviceId: s.S.DJ, quantity: "1", isExternal: true },
        { serviceId: s.S.BUFFET, quantity: "1", isExternal: false },
        { serviceId: s.S.BAND, quantity: "2", isExternal: false },
      ],
    };
    const created = await s.create(choice);
    const quote = ok(
      await s.call(pricingSpecs.quote, {
        spaceId: s.spaceA,
        slotKind: "evening",
        ...choice,
      }),
    );
    const b = await row(created.id);
    expect({
      seasonId: b.seasonId,
      basePrice: b.basePrice,
      extraGuestsAmount: b.extraGuestsAmount,
      itemsTotal: b.itemsTotal,
      removalCreditsTotal: b.removalCreditsTotal,
      discountAmount: b.discountAmount,
      total: b.total,
      baseGuests: b.baseGuests,
      extraGuestPrice: b.extraGuestPrice,
    }).toEqual({
      seasonId: s.summer,
      basePrice: 7_500_000,
      extraGuestsAmount: 450_000,
      itemsTotal: 5_040_000,
      removalCreditsTotal: 300_000,
      discountAmount: 0,
      total: 12_690_000,
      baseGuests: 200,
      extraGuestPrice: 15_000,
    });
    expect(b.total).toBe(quote.total);
    const lines = await db
      .select()
      .from(bookingItems)
      .where(eq(bookingItems.bookingId, created.id))
      .orderBy(bookingItems.sortOrder);
    expect(
      lines.map((l) => ({
        source: l.source,
        serviceId: l.serviceId,
        name: l.name,
        category: l.category,
        pricingType: l.pricingType,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        isExternal: l.isExternal,
        externalFee: l.externalFee,
        isRemoved: l.isRemoved,
        removalCredit: l.removalCredit,
        lineTotal: l.lineTotal,
      })),
    ).toEqual(quote.lines);
    expect(
      summarize({
        basePrice: b.basePrice!,
        extraGuestsAmount: b.extraGuestsAmount!,
        lines: quote.lines,
        discountAmount: 0,
      }).total,
    ).toBe(12_690_000);
  });

  it("B-04: BR-05 — 301 guests in a space of 300 is refused, 300 is accepted, no capacity means no limit", async () => {
    const s = await scenario();
    const over = failed(await s.call(bookingSpecs.createTentative, s.minimal({ packageId: s.gold, guests: "301" })));
    expect(over.rule).toBe("BR-05");
    await s.create({ packageId: s.gold, guests: "300" });
    await s.create({ spaceId: s.spaceB, packageId: s.roof, guests: "5000" });
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ guests: "301" }))).rule).toBe("BR-05");
  });

  it("B-05: BR-06 — an inactive space, an inactive package, a package of another space and an inactive event type are refused", async () => {
    const s = await scenario();
    expect(
      failed(await s.call(bookingSpecs.createTentative, s.minimal({ packageId: s.roof, guests: "100" }))).code,
    ).toBe("NOT_FOUND");
    ok(
      await s.call(
        settingsSpecs.setListItemActive,
        { kind: "eventTypes", id: s.wedding, active: false },
        s.owner.token,
      ),
    );
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ eventTypeId: s.wedding }))).code).toBe(
      "BUSINESS_RULE_VIOLATION",
    );
    const [{ version }] = await db
      .execute(sql`SELECT version FROM packages WHERE id = ${s.gold}`)
      .then((r) => r.rows as { version: number }[]);
    ok(await s.call(catalogSpecs.setPackageActive, { packageId: s.gold, version, active: false }, s.manager.token));
    expect(
      failed(await s.call(bookingSpecs.createTentative, s.minimal({ packageId: s.gold, guests: "100" }))).rule,
    ).toBe("D-87");
    ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: s.spaceA, active: false }, s.manager.token));
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal())).rule).toBe("BR-06");
  });

  it("B-06: BR-12 — a tentative booking on a confirmed slot is saved with a warning naming it; on a tentative one with information", async () => {
    const s = await scenario();
    const first = await s.create({ packageId: s.gold, guests: "200", eventTypeId: s.wedding });
    await confirmBooking(handle, s, first.id);
    const clash = await s.create();
    expect(clash.warnings.confirmedConflicts.map((w: { bookingNo: string }) => w.bookingNo)).toEqual([first.bookingNo]);
    const again = await s.create();
    expect(again.warnings.tentativeOverlaps.map((w: { bookingNo: string }) => w.bookingNo)).toEqual([clash.bookingNo]);
    // Adjacent (O-06) or another space: no warning.
    const adjacent = await s.create({ eventDate: "2027-01-16", slotKind: "day", startTime: "02:00", endTime: "06:00" });
    expect(adjacent.warnings.confirmedConflicts).toEqual([]);
    expect((await s.create({ spaceId: s.spaceB })).warnings.confirmedConflicts).toEqual([]);
    // BR-13: the clashing tentative booking shows as conflicting.
    const page = ok(await s.call(bookingSpecs.get, { bookingId: clash.id }));
    expect(page.booking.displayStatus).toBe("conflicting");
    expect(page.confirmedConflicts.map((c: { bookingNo: string }) => c.bookingNo)).toEqual([first.bookingNo]);
  });

  it("B-07: D-28 and D-52 — link an existing customer or create another with the same number; the suggestion finds the second phone", async () => {
    const s = await scenario();
    const first = await s.create();
    const customerId = (await row(first.id)).customerId;
    await s.create({ customer: { customerId } });
    await s.create({ customer: { name: "أحمد", phone: "+20 100 123 4567" } });
    ok(await s.call(customerSpecs.create, { name: "سارة", phone: "01111111111", altPhone: "٠١٠٠١٢٣٤٥٦٧" }));
    const found = ok(await s.call(customerSpecs.lookupByPhone, { phone: "01001234567" }));
    expect(found.map((c: { name: string }) => c.name).sort()).toEqual(["أحمد", "سارة", "محمد علي"].sort());
    expect(found.find((c: { name: string }) => c.name === "محمد علي").bookingCount).toBe(2);
    const list = ok(await s.call(customerSpecs.list, { search: "سار" }, s.accountant.token));
    expect(list.rows.map((c: { name: string }) => c.name)).toEqual(["سارة"]);
    expect(failed(await s.call(customerSpecs.create, { name: "x", phone: "0101" })).code).toBe("VALIDATION_ERROR");
  });

  it("B-10: numbering — the Cairo year, a fresh counter each year, and a failed booking gives its number back (BR-26, D-105)", async () => {
    const s = await scenario();
    expect((await s.create()).bookingNo).toBe("2026-0001");
    // A refused booking (over capacity) takes no number.
    failed(await s.call(bookingSpecs.createTentative, s.minimal({ packageId: s.gold, guests: "301" })));
    expect((await s.create()).bookingNo).toBe("2026-0002");
    // 00:30 on 1 January in Cairo is 22:30Z on 31 December: already 2027.
    const newYear = new Date("2026-12-31T22:30:00Z");
    const deps = depsAt(handle, newYear);
    const input = {
      ...s.minimal({ customer: { name: "س", phone: "01001234567" } }),
      startTime: null,
      endTime: null,
      eventTypeId: null,
      groomName: null,
      brideName: null,
      packageId: null,
      guests: null,
      items: [],
      removedServiceIds: [],
      notes: null,
    } as never;
    expect((await createTentative(deps, s.reception.actor, input)).bookingNo).toBe("2027-0001");
    const counters = await db.select().from(bookingCounters).orderBy(bookingCounters.year);
    expect(counters.map((c) => [c.year, c.lastNo])).toEqual([
      [2026, 2],
      [2027, 1],
    ]);
  });

  it("B-11: atomicity — a failure in the last step leaves no booking, no new customer, no number and no audit row", async () => {
    const s = await scenario();
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_fail_lines() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced failure'; END; $$`);
    await db.execute(
      sql`CREATE TRIGGER test_fail_lines BEFORE INSERT ON booking_items FOR EACH ROW EXECUTE FUNCTION test_fail_lines()`,
    );
    try {
      const result = await s.call(bookingSpecs.createTentative, s.minimal({ packageId: s.gold, guests: "200" }));
      expect(failed(result).code).toBe("INTERNAL_ERROR");
    } finally {
      await db.execute(sql`DROP TRIGGER test_fail_lines ON booking_items`);
      await db.execute(sql`DROP FUNCTION test_fail_lines()`);
    }
    expect(await db.select().from(bookings)).toHaveLength(0);
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(bookingCounters)).toHaveLength(0);
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(sql`${auditLogs.action} LIKE 'bookings.%' OR ${auditLogs.action} LIKE 'customers.%'`);
    expect(audits).toHaveLength(0);
  });
});
