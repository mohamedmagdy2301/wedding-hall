import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { installments } from "@/db/schema";
import { cairoInstant } from "@/lib/time";
import { bookingSpecs } from "@/server/specs/bookings";
import { paymentSpecs } from "@/server/specs/payments";
import { failed, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { OWNER, signIn } from "./helpers/fixtures";
import { I01, p, paymentScenario, type PaymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE6_PLAN §6.4: the replacement deposit's rebalancing (I-07..I-11, D-121 with the
 * product owner's addition), `installments.set` (BR-65), overdue installments in
 * collections (OD, BR-66, D-120) and the remaining column and filter of S-05 (BR-24, BR-62).
 */

describe("the schedule, collections and the remaining amount (BR-65, BR-66, D-121)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const schedule = async (bookingId: string) =>
    (
      await db.select().from(installments).where(eq(installments.bookingId, bookingId)).orderBy(installments.dueDate)
    ).map((l) => l.amount);

  /** A confirmed booking on schedule I-01 whose 15,000 deposit was voided. */
  async function withoutDeposit(s: PaymentScenario) {
    const a = await s.confirmed();
    ok(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "الشيك رجع" }, s.owner.token));
    return a;
  }
  const replace = (s: PaymentScenario, bookingId: string, amount: string, extra = {}) =>
    s.call(paymentSpecs.recordDeposit, { bookingId, amount, methodId: s.cash, ...extra });

  it("I-07: a replacement of 10,000 — the last installment grows by 5,000", async () => {
    const s = await paymentScenario(handle);
    const a = await withoutDeposit(s);
    const result = ok(await replace(s, a.id, "10,000"));
    expect(result.receiptNo).toBe("000002");
    expect(await schedule(a.id)).toEqual([p("20,000"), p("30,000")]);
  });

  it("I-08 / I-09: 35,000 takes 20,000 off the last one; 45,000 leaves the last at 0.01 and takes the rest from the one before", async () => {
    const s = await paymentScenario(handle);
    const a = await withoutDeposit(s);
    ok(await replace(s, a.id, "35,000"));
    expect(await schedule(a.id)).toEqual([p("20,000"), p("5,000")]);

    const b = await s.confirmed("15,000", I01, { eventDate: "2027-04-15" });
    ok(await s.call(paymentSpecs.void, { paymentId: b.depositId, reason: "الشيك رجع" }, s.owner.token));
    ok(await replace(s, b.id, "45,000"));
    expect(await schedule(b.id)).toEqual([p("14,999.99"), p("0.01")]);
  });

  it("I-10: 60,000 cannot be absorbed without an installment reaching zero → refused, nothing written; with an empty schedule it is accepted", async () => {
    const s = await paymentScenario(handle);
    const a = await withoutDeposit(s);
    expect(failed(await replace(s, a.id, "60,000"))).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "D-121",
      fieldErrors: { installments: expect.any(String) },
    });
    expect(await schedule(a.id)).toEqual([p("20,000"), p("25,000")]);
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.money.payments).toHaveLength(1);

    ok(await replace(s, a.id, "60,000", { installments: [] }));
    expect(await schedule(a.id)).toEqual([]);
  });

  it("I-11: a schedule sent with the replacement is checked as sent — a wrong sum is refused, never rebalanced", async () => {
    const s = await paymentScenario(handle);
    const a = await withoutDeposit(s);
    const wrong = [
      { dueDate: "2027-01-15", amount: "20,000" },
      { dueDate: "2027-03-14", amount: "25,000" },
    ];
    expect(failed(await replace(s, a.id, "10,000", { installments: wrong }))).toMatchObject({
      rule: "BR-65",
      details: { difference: p("5,000") },
    });
    const right = [wrong[0], { dueDate: "2027-03-14", amount: "30,000" }];
    ok(await replace(s, a.id, "10,000", { installments: right }));
    expect(await schedule(a.id)).toEqual([p("20,000"), p("30,000")]);
  });

  it("installments.set replaces the schedule on the booking's version, refuses a stale one, needs an active deposit, and an empty one removes it (BR-65, D-126)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const three = [
      { dueDate: "2026-12-01", amount: "15,000" },
      { dueDate: "2027-01-15", amount: "15,000" },
      { dueDate: "2027-03-01", amount: "15,000" },
    ];
    const set = ok(
      await s.call(paymentSpecs.setInstallments, { bookingId: a.id, version: a.version, installments: three }),
    );
    expect(await schedule(a.id)).toEqual([p("15,000"), p("15,000"), p("15,000")]);
    expect(
      failed(await s.call(paymentSpecs.setInstallments, { bookingId: a.id, version: a.version, installments: [] }))
        .code,
    ).toBe("CONCURRENT_MODIFICATION");
    ok(await s.call(paymentSpecs.setInstallments, { bookingId: a.id, version: set.version, installments: [] }));
    expect(await schedule(a.id)).toEqual([]);

    ok(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "الشيك رجع" }, s.owner.token));
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(
      failed(
        await s.call(paymentSpecs.setInstallments, {
          bookingId: a.id,
          version: page.booking.version,
          installments: three,
        }),
      ),
    ).toMatchObject({ rule: "D-40" });
  });

  it("OD / S-09: collections list what is overdue and due within 7 days, by Cairo day, oldest coverage first (BR-66, D-55, D-120)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed(); // I-01: 20,000 on 2027-01-15, 25,000 on 2027-03-14
    const at = (date: string, time = "10:00") => cairoInstant(date, time);
    const collections = async (now: Date, filters = {}) => {
      const owner = await signIn(handle, OWNER.login, OWNER.password, now);
      return ok(await s.call(paymentSpecs.collections, filters, owner.token, now));
    };

    const early = await collections(at("2027-01-01"));
    expect(early.rows).toEqual([]); // nothing due within 7 days yet
    const dueToday = await collections(at("2027-01-15", "23:30"));
    expect(dueToday.rows.map((r: { state: string; outstanding: number }) => [r.state, r.outstanding])).toEqual([
      ["dueToday", p("20,000")],
    ]);
    const overdue = await collections(at("2027-01-16", "00:01"));
    expect(overdue.rows[0]).toMatchObject({ bookingNo: a.bookingNo, state: "overdue", outstanding: p("20,000") });

    // 30,000 more paid early covers the first (20,000) and 10,000 of the second.
    const owner = await signIn(handle, OWNER.login, OWNER.password, at("2027-01-20"));
    ok(
      await s.call(
        paymentSpecs.record,
        { bookingId: a.id, amount: "30,000", methodId: s.cash },
        owner.token,
        at("2027-01-20"),
      ),
    );
    const later = await collections(at("2027-03-15"));
    expect(
      later.rows.map((r: { dueDate: string; outstanding: number; state: string }) => [
        r.dueDate,
        r.state,
        r.outstanding,
      ]),
    ).toEqual([["2027-03-14", "overdue", p("15,000")]]);
    const filtered = await collections(at("2027-03-15"), { from: "2027-03-15", to: "2027-03-31" });
    expect(filtered.rows).toEqual([]);
  });

  it("S-05: the list shows what is still owed on confirmed bookings and filters on it; a completed one with money due stays visible (BR-24, BR-62)", async () => {
    const s = await paymentScenario(handle);
    const owed = await s.confirmed("15,000", []);
    const paid = await s.confirmed("60,000", [], { eventDate: "2027-04-15" });
    const tentative = await s.tentative({ eventDate: "2027-05-15" });
    const list = ok(await s.call(bookingSpecs.list, {}));
    const remaining = (id: string) => list.rows.find((r: { id: string }) => r.id === id).remaining;
    expect([remaining(owed.id), remaining(paid.id), remaining(tentative.id)]).toEqual([p("45,000"), 0, null]);

    const due = ok(await s.call(bookingSpecs.list, { balance: "due" }));
    expect(due.rows.map((r: { id: string }) => r.id)).toEqual([owed.id]);

    // After the party (BR-24): completed, still owing, still listed.
    const after = cairoInstant("2027-03-20", "12:00");
    const owner = await signIn(handle, OWNER.login, OWNER.password, after);
    const completed = ok(await s.call(bookingSpecs.list, { balance: "due" }, owner.token, after));
    expect(
      completed.rows.map((r: { displayStatus: string; remaining: number }) => [r.displayStatus, r.remaining]),
    ).toEqual([["completed", p("45,000")]]);
  });
});
