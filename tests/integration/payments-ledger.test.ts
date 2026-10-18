import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, bookings, payments } from "@/db/schema";
import { cairoInstant } from "@/lib/time";
import { bookingSpecs } from "@/server/specs/bookings";
import { paymentSpecs } from "@/server/specs/payments";
import { settingsSpecs } from "@/server/specs/settings";
import { failed, NOW, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { pgErrorCode } from "./helpers/pg-error";
import { p, paymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE6_PLAN §6.3 and §6.5: the ledger through the services (L-04, L-05), receipt numbers
 * (N-01..N-03), receipts as of issuance (RC-01..RC-04), backdated payments (BD-01..BD-03),
 * voiding (V-01..V-05), payments only on confirmed bookings (P-01) and permissions (SEC-11).
 */

describe("payments, receipts and voiding (BR-60..64, D-118, D-122, D-125)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const pay = (s: Awaited<ReturnType<typeof paymentScenario>>, bookingId: string, amount: string, extra = {}) =>
    s.call(paymentSpecs.record, { bookingId, amount, methodId: s.wallet, ...extra }, s.reception.token);
  const receipt = async (s: Awaited<ReturnType<typeof paymentScenario>>, paymentId: string) =>
    ok(await s.call(paymentSpecs.receipt, { paymentId }, s.reception.token));

  it("N-01 / L-04: payments on two bookings take 000001, 000002, 000003; 25,000.01 over a 25,000 balance is refused, 25,000 accepted", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const b = await s.confirmed("15,000", [], { eventDate: "2027-04-15" });
    expect([a.receiptNo, b.receiptNo]).toEqual(["000001", "000002"]);
    const installment = ok(await pay(s, a.id, "20,000"));
    expect(installment).toMatchObject({ receiptNo: "000003", kind: "installment" });
    expect(ok(await pay(s, b.id, "1,000")).kind).toBe("payment"); // no schedule (D-126)

    const over = failed(await pay(s, a.id, "25,000.01"));
    expect(over).toMatchObject({ code: "BUSINESS_RULE_VIOLATION", rule: "BR-63" });
    expect((over as { details?: Record<string, unknown> }).details).toEqual({ remaining: p("25,000") });
    expect(ok(await pay(s, a.id, "25,000")).receiptNo).toBe("000005");
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.money.ledger.remaining).toBe(0);
    expect(page.money.installments.map((l: { state: string }) => l.state)).toEqual(["paid", "paid"]);
  });

  it("N-02 / N-03 / V-01 / L-05: a voided payment keeps its number and leaves the ledger; a refused one uses no number", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const second = ok(await pay(s, a.id, "20,000"));
    ok(await s.call(paymentSpecs.void, { paymentId: second.paymentId, reason: "اتسجلت غلط" }, s.manager.token));
    const [voided] = await db.select().from(payments).where(eq(payments.id, second.paymentId));
    expect(voided).toMatchObject({ receiptNo: "000002", voidReason: "اتسجلت غلط", voidedBy: s.manager.actor.userId });

    expect(failed(await pay(s, a.id, "45,000.01")).rule).toBe("BR-63");
    expect(ok(await pay(s, a.id, "45,000")).receiptNo).toBe("000003"); // room again after the void (L-05)
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.money.ledger).toMatchObject({ paid: p("60,000"), remaining: 0 });
    const voidAudit = await db.select().from(auditLogs).where(eq(auditLogs.action, "payments.void"));
    expect(voidAudit).toHaveLength(1);
    expect(page.history.map((h: { action: string }) => h.action)).toContain("payments.void");
  });

  it("RC-01..RC-04: a receipt shows paid and remaining as of its issuance — by number, not date, and voids after it do not change it (D-122)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const second = ok(await pay(s, a.id, "20,000"));
    expect(await receipt(s, a.depositId)).toMatchObject({ paid: p("15,000"), remaining: p("45,000") }); // RC-01

    ok(await s.call(paymentSpecs.void, { paymentId: second.paymentId, reason: "اتسجلت غلط" }, s.owner.token));
    expect(await receipt(s, a.depositId)).toMatchObject({ paid: p("15,000"), remaining: p("45,000") }); // RC-02
    expect(await receipt(s, second.paymentId)).toMatchObject({
      receiptNo: "000002",
      voidReason: "اتسجلت غلط",
      paid: p("35,000"),
      remaining: p("25,000"),
    }); // RC-03

    // RC-04: a backdated payment recorded after 000002 counts by its number.
    const backdated = ok(
      await s.call(
        paymentSpecs.record,
        { bookingId: a.id, amount: "5,000", methodId: s.cash, paidAt: "2026-05-01" },
        s.owner.token,
      ),
    );
    expect(backdated.receiptNo).toBe("000003");
    const third = await receipt(s, backdated.paymentId);
    expect(third).toMatchObject({ paid: p("20,000"), remaining: p("40,000") }); // 000002 voided before it
  });

  it("BD-01..BD-03: only payments.backdate dates a payment; the date is from 3 years ago to today, stored at noon Cairo and audited (D-118)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const ownerPay = (paidAt: string) =>
      s.call(paymentSpecs.record, { bookingId: a.id, amount: "1,000", methodId: s.cash, paidAt }, s.owner.token);

    const old = ok(await ownerPay("2026-05-01"));
    const [row] = await db.select().from(payments).where(eq(payments.id, old.paymentId));
    expect(row.paidAt.getTime()).toBe(cairoInstant("2026-05-01", "12:00").getTime());
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.entityId} = ${old.paymentId}`);
    expect(audit.meta).toMatchObject({ backdated: true, bookingId: a.id });

    // BD-02: the manager has no payments.backdate by default; reception neither.
    for (const token of [s.manager.token, s.reception.token]) {
      const error = failed(
        await s.call(
          paymentSpecs.record,
          { bookingId: a.id, amount: "1,000", methodId: s.cash, paidAt: "2026-05-01" },
          token,
        ),
      );
      expect(error).toMatchObject({ code: "FORBIDDEN", rule: "D-118" });
    }
    // BD-03: tomorrow and older than three years are refused; today is just now.
    expect(failed(await ownerPay("2026-10-19")).fieldErrors).toHaveProperty("paidAt");
    expect(failed(await ownerPay("2023-10-17")).fieldErrors).toHaveProperty("paidAt");
    ok(await ownerPay("2023-10-18"));
    const today = ok(await ownerPay("2026-10-18"));
    const [todayRow] = await db.select().from(payments).where(eq(payments.id, today.paymentId));
    expect(todayRow.paidAt.getTime()).toBe(NOW.getTime());

    // A backdated deposit at confirmation (D-109, D-117).
    const legacy = await s.tentative({ eventDate: "2027-04-15" });
    const confirm = s.confirmInput(legacy, "15,000", [], {
      deposit: { amount: "15,000", methodId: s.cash, paidAt: "2026-06-01" },
    });
    expect(failed(await s.call(bookingSpecs.confirm, confirm, s.reception.token)).code).toBe("FORBIDDEN");
    const confirmed = ok(await s.call(bookingSpecs.confirm, confirm, s.owner.token));
    const [deposit] = await db.select().from(payments).where(eq(payments.id, confirmed.paymentId));
    expect(deposit.paidAt.getTime()).toBe(cairoInstant("2026-06-01", "12:00").getTime());
  });

  it("V-02 / V-03 / V-04: voiding the deposit keeps the booking confirmed and flags it; a second deposit is refused while one is active; a payment voids once, with a reason", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    expect(
      failed(await s.call(paymentSpecs.recordDeposit, { bookingId: a.id, amount: "1,000", methodId: s.cash })),
    ).toMatchObject({ rule: "BR-60" });

    expect(failed(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "x" }, s.owner.token)).code).toBe(
      "VALIDATION_ERROR",
    );
    const voided = ok(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "الشيك رجع" }, s.owner.token));
    expect(voided.depositVoided).toBe(true);
    expect(
      failed(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "تاني" }, s.owner.token)),
    ).toMatchObject({
      rule: "BR-64",
    });
    const [row] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, a.id));
    expect(row.status).toBe("confirmed");
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.money).toMatchObject({ depositMissing: true, activeDeposit: null });

    // The minimum is for confirming (BR-21): a smaller replacement is accepted (I-07).
    const replacement = ok(
      await s.call(paymentSpecs.recordDeposit, { bookingId: a.id, amount: "10,000", methodId: s.cash }),
    );
    expect(replacement.receiptNo).toBe("000002");
    const after = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(after.money).toMatchObject({ depositMissing: false, activeDeposit: { amount: p("10,000") } });
  });

  it("V-05: the database refuses deleting a payment or changing it other than voiding it once (D-125)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const attempt = (statement: Promise<unknown>) => statement.then(() => null, pgErrorCode);
    expect(await attempt(db.delete(payments).where(eq(payments.id, a.depositId)))).toBe("42501");
    expect(await attempt(db.update(payments).set({ amount: 1 }).where(eq(payments.id, a.depositId)))).toBe("42501");
    await db
      .update(payments)
      .set({ voidedAt: new Date(), voidedBy: s.ownerId, voidReason: "اختبار" })
      .where(eq(payments.id, a.depositId));
    expect(await attempt(db.update(payments).set({ voidReason: "سبب تاني" }).where(eq(payments.id, a.depositId)))).toBe(
      "42501",
    );
  });

  it("P-01: a tentative booking takes no payment (BR-25), nor a cancelled one; an inactive payment method is refused", async () => {
    const s = await paymentScenario(handle);
    const tentative = await s.tentative();
    expect(failed(await pay(s, tentative.id, "1,000"))).toMatchObject({ rule: "BR-25" });

    const a = await s.confirmed("15,000", [], { eventDate: "2027-04-15" });
    await db.execute(
      sql`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${s.ownerId}, cancel_reason = 'اختبار' WHERE id = ${a.id}`,
    );
    expect(failed(await pay(s, a.id, "1,000")).message).toContain("ملغي");

    const b = await s.confirmed("15,000", [], { eventDate: "2027-05-15" });
    ok(
      await s.call(
        settingsSpecs.setListItemActive,
        { kind: "paymentMethods", id: s.wallet, active: false },
        s.owner.token,
      ),
    );
    expect(failed(await pay(s, b.id, "1,000")).fieldErrors).toHaveProperty("methodId");
  });

  it("SEC-11: every payment operation refuses without a session and without its permission", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    const record = { bookingId: a.id, amount: "1,000", methodId: s.cash };
    expect(failed(await s.call(paymentSpecs.record, record, null)).code).toBe("UNAUTHENTICATED");
    const viewer = await s.staffWith("viewer", ["bookings.view"]);
    expect(failed(await s.call(paymentSpecs.record, record, viewer.token)).code).toBe("FORBIDDEN");
    expect(failed(await s.call(paymentSpecs.recordDeposit, record, viewer.token)).code).toBe("FORBIDDEN");
    expect(failed(await s.call(paymentSpecs.collections, {}, viewer.token)).code).toBe("FORBIDDEN");
    expect(
      failed(
        await s.call(
          paymentSpecs.setInstallments,
          { bookingId: a.id, version: a.version, installments: [] },
          viewer.token,
        ),
      ).code,
    ).toBe("FORBIDDEN");
    // Reception records but does not void (default roles); the accountant neither voids.
    for (const token of [s.reception.token, s.accountant.token, viewer.token]) {
      expect(failed(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "اختبار" }, token)).code).toBe(
        "FORBIDDEN",
      );
    }
    expect(ok(await s.call(paymentSpecs.receipt, { paymentId: a.depositId }, viewer.token)).receiptNo).toBe("000001");
  });
});
