import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookingChanges, bookings, discountRequests, installments, payments } from "@/db/schema";
import { bookingSpecs } from "@/server/specs/bookings";
import { discountSpecs } from "@/server/specs/discounts";
import { paymentSpecs } from "@/server/specs/payments";
import { failed, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { pgErrorCode } from "./helpers/pg-error";
import { p, paymentScenario, type PaymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE7_PLAN §4.1 through the action pipeline (BR-50..52, Q7-01..Q7-04, D-129): the phase 6
 * wedding — 60,000, deposit 15,000, schedule 20,000 + 25,000 (I-01).
 */

describe("discounts (BR-50..52, D-129)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const request = (s: PaymentScenario, bookingId: string, amount: string, token = s.reception.token, extra = {}) =>
    s.call(discountSpecs.request, { bookingId, amount, reason: "عميل قديم", ...extra }, token);
  const decide = (s: PaymentScenario, requestId: string, approve: boolean, extra = {}) =>
    s.call(discountSpecs.decide, { requestId, approve, ...extra }, s.manager.token);
  const total = async (bookingId: string) =>
    (await db.select({ total: bookings.total }).from(bookings).where(eq(bookings.id, bookingId)))[0].total;
  const schedule = async (bookingId: string) =>
    (
      await db.select().from(installments).where(eq(installments.bookingId, bookingId)).orderBy(installments.dueDate)
    ).map((l) => l.amount);

  it("DS-01 / DS-02: a pending 2,000 changes nothing (BR-50); approved, the total is 58,000, the last installment 23,000 and the change is recorded", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const asked = ok(await request(s, a.id, "2,000"));
    expect(asked.status).toBe("pending");
    expect(await total(a.id)).toBe(p("60,000"));

    const approved = ok(await decide(s, asked.requestId, true, { note: "تمام" }));
    expect(approved).toMatchObject({ status: "approved", total: p("58,000") });
    expect(await total(a.id)).toBe(p("58,000"));
    expect(await schedule(a.id)).toEqual([p("20,000"), p("23,000")]);
    const [change] = await db.select().from(bookingChanges).where(eq(bookingChanges.bookingId, a.id));
    expect(change).toMatchObject({ kind: "discount", totalBefore: p("60,000"), totalAfter: p("58,000") });
    const [row] = await db.select().from(discountRequests).where(eq(discountRequests.id, asked.requestId));
    expect(row).toMatchObject({ status: "approved", decidedBy: s.manager.actor.userId, decisionNote: "تمام" });

    // D-122: the deposit's receipt keeps the total it was issued against.
    const receipt = ok(await s.call(paymentSpecs.receipt, { paymentId: a.depositId }));
    expect(receipt).toMatchObject({ total: p("60,000"), paid: p("15,000"), remaining: p("45,000") });
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(["discounts.request", "discounts.approve"]),
    );
  });

  it("DS-03: the manager's own request is approved at once, with the manager as the approver (BR-51)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const result = ok(await request(s, a.id, "1,000", s.manager.token));
    expect(result).toMatchObject({ status: "approved", total: p("59,000") });
    const [row] = await db.select().from(discountRequests).where(eq(discountRequests.bookingId, a.id));
    expect(row).toMatchObject({ requestedBy: s.manager.actor.userId, decidedBy: s.manager.actor.userId });
  });

  it("DS-04: two pending 31,000 and 30,000 — the first approved leaves 29,000, the second is refused by BR-52 at approval", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const first = ok(await request(s, a.id, "31,000"));
    const second = ok(await request(s, a.id, "30,000"));
    ok(await decide(s, first.requestId, true));
    expect(failed(await decide(s, second.requestId, true))).toMatchObject({ rule: "BR-52" });
    expect(await total(a.id)).toBe(p("29,000"));
    expect(failed(await request(s, a.id, "29,000.01")).rule).toBe("BR-52");
  });

  it("DS-05 / Q7-04: a discount of the whole 60,000 after a 15,000 deposit refunds 15,000 in the same operation (policy refund)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const asked = ok(await request(s, a.id, "60,000"));
    const noMethod = failed(await decide(s, asked.requestId, true));
    expect(noMethod.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(noMethod.fieldErrors ?? {})).toEqual(["credit.methodId"]);
    const done = ok(await decide(s, asked.requestId, true, { credit: { resolution: "refund", methodId: s.cash } }));
    expect(done.total).toBe(0);
    expect(done.refund).toMatchObject({ receiptNo: "000002", amount: p("15,000") });
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.money.ledger).toMatchObject({ total: 0, paid: 0, remaining: 0 });
    expect(await schedule(a.id)).toEqual([]);
    const [change] = await db.select().from(bookingChanges).where(eq(bookingChanges.bookingId, a.id));
    expect(change.creditResolution).toBe("refund");
    const refund = ok(await s.call(paymentSpecs.receipt, { paymentId: done.refund.paymentId }));
    expect(refund).toMatchObject({ kind: "refund", total: 0, paid: 0, remaining: 0 });
  });

  it("DS-06 / Q7-01: a tentative booking keeps its approved 2,000 through the re-pricing at confirmation", async () => {
    const s = await paymentScenario(handle);
    const b = await s.tentative();
    const approved = ok(await request(s, b.id, "2,000", s.manager.token));
    expect(approved.total).toBe(p("58,000"));
    await s.setEveningPrice("61,000");
    const confirm = (expected: string) =>
      s.call(
        bookingSpecs.confirm,
        { ...s.confirmInput({ id: b.id, version: approved.version }, "15,000", []), expectedTotal: p(expected) },
        s.reception.token,
      );
    expect(failed(await confirm("60,000")).code).toBe("PRICE_CHANGED");
    expect(ok(await confirm("59,000")).total).toBe(p("59,000"));
    expect(await db.select().from(bookingChanges)).toEqual([]); // nothing changed after confirmation
  });

  it("Q7-01: re-pricing a tentative booking keeps the discount; without a package it is refused", async () => {
    const s = await paymentScenario(handle);
    const b = await s.tentative();
    const approved = ok(await request(s, b.id, "2,000", s.manager.token));
    const update = (extra: Record<string, unknown>) =>
      s.call(bookingSpecs.updateTentative, { ...s.weddingInput(extra), bookingId: b.id, version: approved.version });
    expect(failed(await update({ packageId: "", guests: "" }))).toMatchObject({ rule: "BR-50" });
    ok(await update({ guests: "210" }));
    expect(await total(b.id)).toBe(p("60,000") + p("1,500") - p("2,000"));

    const bare = ok(await s.call(bookingSpecs.createTentative, s.minimal()));
    expect(failed(await request(s, bare.id, "100")).rule).toBe("BR-50");
  });

  it("DS-07 / Q7-03: the requester withdraws a pending request; an approved one stays; the accountant may not", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const pending = ok(await request(s, a.id, "500"));
    expect(
      failed(await s.call(discountSpecs.withdraw, { requestId: pending.requestId }, s.accountant.token)).code,
    ).toBe("FORBIDDEN");
    expect(ok(await s.call(discountSpecs.withdraw, { requestId: pending.requestId })).status).toBe("withdrawn");
    const approved = ok(await request(s, a.id, "500", s.manager.token));
    expect(
      failed(await s.call(discountSpecs.withdraw, { requestId: approved.requestId }, s.manager.token)),
    ).toMatchObject({ rule: "D-129" });
    expect(await total(a.id)).toBe(p("59,500"));
  });

  it("a rejection changes nothing; the reception may not decide; pending ones are listed for the approver with the credit approving would make", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const one = ok(await request(s, a.id, "1,000"));
    const two = ok(await request(s, a.id, "50,000"));
    expect(failed(await s.call(discountSpecs.decide, { requestId: one.requestId, approve: true })).code).toBe(
      "FORBIDDEN",
    );
    expect(failed(await s.call(discountSpecs.listPending, {})).code).toBe("FORBIDDEN");
    const pending = ok(await s.call(discountSpecs.listPending, {}, s.manager.token));
    expect(pending.map((r: { amount: number; credit: number }) => [r.amount, r.credit])).toEqual([
      [p("1,000"), 0],
      [p("50,000"), p("5,000")],
    ]);
    ok(await decide(s, one.requestId, false, { note: "مش مناسب" }));
    expect(await total(a.id)).toBe(p("60,000"));
    expect(failed(await decide(s, one.requestId, true)).rule).toBe("D-129");
    expect(ok(await s.call(discountSpecs.listPending, {}, s.manager.token))).toHaveLength(1);
    void two;
  });

  it("D-129 / D-130: requests are never deleted nor changed after their decision; changes are append-only", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const approved = ok(await request(s, a.id, "1,000", s.manager.token));
    const tryIt = async (work: () => Promise<unknown>) => {
      try {
        await work();
        return "ok";
      } catch (error) {
        return pgErrorCode(error);
      }
    };
    expect(await tryIt(() => db.delete(discountRequests).where(eq(discountRequests.id, approved.requestId)))).toBe(
      "42501",
    );
    expect(
      await tryIt(() =>
        db.update(discountRequests).set({ amount: 1 }).where(eq(discountRequests.id, approved.requestId)),
      ),
    ).toBe("42501");
    expect(await tryIt(() => db.update(bookingChanges).set({ totalAfter: 1 }))).toBe("42501");
    expect(await tryIt(() => db.delete(bookingChanges))).toBe("42501");
    expect(await db.select().from(payments).where(eq(payments.kind, "refund"))).toEqual([]);
  });
});
