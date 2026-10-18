import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { auditLogs, bookingCounters, bookingItems, bookings, customers, spaces } from "@/db/schema";
import { summarize } from "@/domain/pricing";
import { addMs } from "@/lib/time";
import { createTentative } from "@/modules/bookings/service";
import { catalogSpecs } from "@/server/specs/catalog";
import { availabilitySpecs, bookingSpecs, customerSpecs } from "@/server/specs/bookings";
import type { ProtectedSpec } from "@/server/specs/define";
import { pricingSpecs } from "@/server/specs/pricing";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { confirmBooking, SLOTS } from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";
import { addStaff, callSpec, depsAt, OWNER, setUpVenueWithOwner, signIn } from "./helpers/fixtures";

/**
 * PHASE5_PLAN §9.5 (B-01..B-22) and C-06..C-08: tentative bookings through the real action
 * pipeline (session → Zod → permission → service). The clock is fixed at
 * 2026-10-18 13:00 Cairo so the date window (BR-27) and the numbering year never drift.
 */

type AnySpec = ProtectedSpec<z.ZodType, unknown>;
type Failure = { code: string; rule?: string; fieldErrors?: Record<string, string> };
type Result = { ok: true; data: any } | { ok: false; error: Failure }; // eslint-disable-line @typescript-eslint/no-explicit-any

const NOW = new Date("2026-10-18T10:00:00Z");
const HOUR = 3_600_000;

const ok = (result: Result) => {
  if (!result.ok)
    throw new Error(
      `${result.error.code} ${result.error.rule ?? ""} ${JSON.stringify(result.error.fieldErrors ?? {})}`,
    );
  return result.data;
};
const failed = (result: Result) => {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
};

describe("bookings (phase 5)", () => {
  const handle = connectTestDb();
  const second = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(async () => {
    await handle.close();
    await second.close();
  });

  async function scenario() {
    const base = await setUpVenueWithOwner(handle);
    const staff = async (login: string, role: string) => {
      const s = await addStaff(handle, base.owner.actor, login, [base.roleId(role)]);
      return signIn(handle, login, s.password, NOW);
    };
    const owner = await signIn(handle, OWNER.login, OWNER.password, NOW);
    const manager = await staff("manager", "مدير");
    const reception = await staff("reception", "استقبال/حجوزات");
    const accountant = await staff("accountant", "محاسب");
    // `null` = no session (an explicit `undefined` would take the default token).
    const call = (spec: unknown, input: unknown, token: string | null = reception.token, now = NOW) =>
      callSpec(handle, spec as AnySpec, token ?? undefined, input, now) as Promise<Result>;

    ok(await call(settingsSpecs.updateTiming, { bufferMinutes: "60", tentativeHoldHours: "48" }, owner.token));
    const spaceA = ok(
      await call(spaceSpecs.createSpace, { name: "القاعة الكبرى", capacityMax: "300", ...SLOTS }, manager.token),
    ).id as string;
    const spaceB = ok(await call(spaceSpecs.createSpace, { name: "الروف", capacityMax: "", ...SLOTS }, manager.token))
      .id as string;
    const wedding = ok(
      await call(settingsSpecs.createListItem, { kind: "eventTypes", name: "فرح", isWedding: true }, owner.token),
    ).id as string;
    const summer = ok(
      await call(
        settingsSpecs.createSeason,
        { name: "الصيف", startDate: "2027-06-01", endDate: "2027-09-30" },
        manager.token,
      ),
    ).id as string;

    const service = async (name: string, pricingType: string, unitPrice: string, externalFee: string | null = null) =>
      ok(
        await call(
          catalogSpecs.createService,
          {
            name,
            category: "service",
            pricingType,
            unitPrice,
            allowExternal: externalFee !== null,
            externalFee: externalFee ?? "",
          },
          manager.token,
        ),
      ).id as string;
    const S = {
      DJ: await service("دي جي", "fixed", "5000", "1000"),
      PHOTO: await service("تصوير", "per_unit", "2500", ""),
      BUFFET: await service("بوفيه عشاء", "per_guest", "180"),
      ZAFFA: await service("زفة", "fixed", "3000"),
      WELCOME: await service("مشروب ترحيب", "per_guest", "25.50"),
      BAND: await service("فرقة", "per_unit", "4000", "1500"),
    };
    const gold = ok(
      await call(
        catalogSpecs.createPackage,
        {
          spaceId: spaceA,
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
          ],
          items: [
            { serviceId: S.DJ, quantity: "1", removable: true, removalCredit: "3000" },
            { serviceId: S.PHOTO, quantity: "2", removable: true, removalCredit: "2000" },
            { serviceId: S.ZAFFA, quantity: "1", removable: false, removalCredit: "" },
            { serviceId: S.WELCOME, quantity: "1", removable: true, removalCredit: "4000" },
          ],
        },
        manager.token,
      ),
    ).id as string;
    const roof = ok(
      await call(
        catalogSpecs.createPackage,
        {
          spaceId: spaceB,
          name: "الروف",
          description: "",
          baseGuests: "50",
          extraGuestPrice: "100",
          isActive: true,
          prices: [{ slotKind: "evening", seasonId: null, price: "10000" }],
          items: [],
        },
        manager.token,
      ),
    ).id as string;

    const minimal = (extra: Record<string, unknown> = {}) => ({
      spaceId: spaceA,
      eventDate: "2027-01-15",
      slotKind: "evening",
      customer: { name: "محمد علي", phone: "0100 123 4567" },
      ...extra,
    });
    const create = async (extra: Record<string, unknown> = {}, token?: string, now?: Date) =>
      ok(await call(bookingSpecs.createTentative, minimal(extra), token, now));

    return {
      ...base,
      owner,
      manager,
      reception,
      accountant,
      call,
      spaceA,
      spaceB,
      wedding,
      summer,
      S,
      gold,
      roof,
      minimal,
      create,
    };
  }

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

  it("B-14: SEC-11 — every operation refuses without a session and without its permission", async () => {
    const s = await scenario();
    const created = await s.create();
    const b = await row(created.id);
    const ops: [unknown, unknown][] = [
      [bookingSpecs.createTentative, s.minimal()],
      [
        bookingSpecs.updateTentative,
        { ...s.minimal({ customer: { customerId: b.customerId } }), bookingId: b.id, version: 1 },
      ],
      [bookingSpecs.extendTentative, { bookingId: b.id, version: 1 }],
      [
        bookingSpecs.updateDetails,
        {
          bookingId: b.id,
          version: 1,
          customerId: b.customerId,
          eventTypeId: "",
          groomName: "",
          brideName: "",
          notes: "",
        },
      ],
      [customerSpecs.lookupByPhone, { phone: "01001234567" }],
      [customerSpecs.create, { name: "س", phone: "01001234567" }],
      [customerSpecs.update, { customerId: b.customerId, name: "س", phone: "01001234567" }],
    ];
    const code = (r: Result) => (r.ok ? "OK" : r.error.code);
    for (const [spec, input] of ops) {
      expect(code(await s.call(spec, input, null))).toBe("UNAUTHENTICATED");
    }
    const asAccountant = [];
    for (const [spec, input] of ops) asAccountant.push(code(await s.call(spec, input, s.accountant.token)));
    expect(asAccountant).toEqual(ops.map(() => "FORBIDDEN"));
    // The accountant (bookings.view) reads.
    for (const [spec, input] of [
      [bookingSpecs.get, { bookingId: b.id }],
      [bookingSpecs.list, {}],
      [availabilitySpecs.check, { spaceId: s.spaceA, eventDate: "2027-01-15", slotKind: "evening" }],
      [availabilitySpecs.calendar, { from: "2027-01-01", to: "2027-01-31" }],
      [customerSpecs.list, {}],
      [customerSpecs.get, { customerId: b.customerId }],
    ] as [unknown, unknown][]) {
      ok(await s.call(spec, input, s.accountant.token));
      expect(failed(await s.call(spec, input, null)).code).toBe("UNAUTHENTICATED");
    }
    // The reception edits and extends; spaces.upcomingBookings is catalog.manage.
    ok(await s.call(bookingSpecs.extendTentative, { bookingId: b.id, version: 1 }));
    expect(failed(await s.call(spaceSpecs.upcomingBookings, { spaceId: s.spaceA })).code).toBe("FORBIDDEN");
  });

  it("B-15: venue isolation — another venue's rows are not found and its bookings raise no warning", async () => {
    const s = await scenario();
    const created = await s.create();
    const b = await row(created.id);
    const [otherVenue] = await db
      .execute(
        sql`INSERT INTO venues (name, buffer_minutes, tentative_hold_hours, min_deposit_type, min_deposit_value, cancellation_basis, postpone_credit_mode) VALUES ('أخرى', 60, 48, 'none', 0, 'deposit', 'refund') RETURNING id`,
      )
      .then((r) => r.rows as { id: string }[]);
    await db.update(spaces).set({ venueId: otherVenue.id }).where(eq(spaces.id, s.spaceB));
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ spaceId: s.spaceB }))).code).toBe("NOT_FOUND");
    await db.update(customers).set({ venueId: otherVenue.id }).where(eq(customers.id, b.customerId));
    expect(
      failed(await s.call(bookingSpecs.createTentative, s.minimal({ customer: { customerId: b.customerId } }))).code,
    ).toBe("NOT_FOUND");
    expect(failed(await s.call(customerSpecs.get, { customerId: b.customerId })).code).toBe("NOT_FOUND");
    await db.update(bookings).set({ venueId: otherVenue.id }).where(eq(bookings.id, b.id));
    expect(failed(await s.call(bookingSpecs.get, { bookingId: b.id })).code).toBe("NOT_FOUND");
    const listed = ok(await s.call(bookingSpecs.list, {}));
    expect(listed.rows).toHaveLength(0);
  });

  it("B-16: D-75 / D-112 — the upcoming bookings of a space, and deactivating it changes none of them", async () => {
    const s = await scenario();
    const live = await s.create();
    await s.create({ eventDate: "2027-01-20" }, undefined, addMs(NOW, -100 * HOUR)); // expired by now
    const toConfirm = await s.create({
      eventDate: "2027-02-01",
      packageId: s.gold,
      guests: "200",
      eventTypeId: s.wedding,
    });
    await confirmBooking(handle, s, toConfirm.id);
    const counts = ok(await s.call(spaceSpecs.upcomingBookings, { spaceId: s.spaceA }, s.manager.token));
    expect(counts).toEqual({ confirmed: 1, tentative: 1 });
    const before = await db.select().from(bookings).orderBy(bookings.bookingNo);
    ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: s.spaceA, active: false }, s.manager.token));
    const after = await db.select().from(bookings).orderBy(bookings.bookingNo);
    expect(after.map((b) => [b.status, b.startsAt, b.version])).toEqual(
      before.map((b) => [b.status, b.startsAt, b.version]),
    );
    expect((await row(live.id)).status).toBe("tentative");
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

  it("B-18: the calendar returns the range's bookings with their status, and refuses more than 42 days", async () => {
    const s = await scenario();
    await s.create();
    await s.create({ eventDate: "2027-03-01" });
    await s.create({ eventDate: "2027-01-20" }, undefined, addMs(NOW, -100 * HOUR));
    const result = ok(await s.call(availabilitySpecs.calendar, { from: "2027-01-01", to: "2027-01-31" }));
    expect(
      result.bookings.map((b: { eventDate: string; displayStatus: string }) => [b.eventDate, b.displayStatus]),
    ).toEqual([
      ["2027-01-15", "tentative"],
      ["2027-01-20", "expired"],
    ]);
    expect(result.spaces).toHaveLength(2);
    expect(failed(await s.call(availabilitySpecs.calendar, { from: "2027-01-01", to: "2027-02-12" })).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("BR-27 / D-111: the date window, and availability.check flags times running into the other slot", async () => {
    const s = await scenario();
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ eventDate: "2026-10-17" }))).rule).toBe(
      "BR-27",
    );
    expect(failed(await s.call(bookingSpecs.createTentative, s.minimal({ eventDate: "2029-10-19" }))).rule).toBe(
      "BR-27",
    );
    expect(
      failed(
        await s.call(
          bookingSpecs.createTentative,
          s.minimal({ eventDate: "2026-10-18", slotKind: "day", startTime: "12:00", endTime: "14:00" }),
        ),
      ).rule,
    ).toBe("BR-27");
    await s.create({ eventDate: "2026-10-18" });
    const check = ok(
      await s.call(availabilitySpecs.check, {
        spaceId: s.spaceA,
        eventDate: "2027-01-15",
        slotKind: "day",
        startTime: "13:00",
        endTime: "23:00",
      }),
    );
    expect(check.intrudesOtherSlot).toBe(true);
    expect(new Date(check.blockedUntil).getTime() - new Date(check.endsAt).getTime()).toBe(60 * 60_000);
    expect(
      failed(
        await s.call(availabilitySpecs.check, {
          spaceId: s.spaceA,
          eventDate: "2027-01-15",
          slotKind: "day",
          startTime: "13:00",
          endTime: "13:00",
        }),
      ).fieldErrors,
    ).toHaveProperty("endTime");
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

  it("the list: search by number and mobile, filter by the status shown now", async () => {
    const s = await scenario();
    const a = await s.create();
    await s.create({ eventDate: "2027-02-01", customer: { name: "منى", phone: "01222222222" } });
    await s.create({ eventDate: "2027-01-20" }, undefined, addMs(NOW, -100 * HOUR));
    const list = (filters: Record<string, unknown>) => s.call(bookingSpecs.list, filters, s.accountant.token).then(ok);
    expect((await list({ search: a.bookingNo })).rows.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect((await list({ search: "01222222222" })).total).toBe(1);
    expect((await list({ search: "منى" })).total).toBe(1);
    expect((await list({ status: "expired" })).total).toBe(1);
    expect((await list({ status: "tentative" })).total).toBe(2);
    expect((await list({ from: "2027-01-16", to: "2027-02-01" })).total).toBe(2);
  });

  it("C-06: 20 tentative bookings created at once get 2026-0001..0020 with no duplicate or gap", async () => {
    const s = await scenario();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => s.call(bookingSpecs.createTentative, s.minimal())),
    );
    const numbers = results.map((r) => ok(r).bookingNo).sort();
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => `2026-${String(i + 1).padStart(4, "0")}`));
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
