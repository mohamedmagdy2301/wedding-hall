import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, customers, spaces } from "@/db/schema";
import { addMs } from "@/lib/time";
import { availabilitySpecs, bookingSpecs, customerSpecs } from "@/server/specs/bookings";
import { spaceSpecs } from "@/server/specs/spaces";
import { confirmBooking } from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";
import { bookingScenario, type Result, NOW, HOUR, ok, failed } from "./helpers/booking-scenario";

/**
 * PHASE5_PLAN §9.5 (B-14, B-15, B-16, B-18, BR-27 / D-111, the list, C-06): tentative bookings through the real action
 * pipeline (session → Zod → permission → service), on the shared scenario.
 */
describe("bookings: permissions, isolation and reads (phase 5)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const scenario = () => bookingScenario(handle);
  const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];

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
});
