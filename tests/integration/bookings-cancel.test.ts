import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, bookings, discountRequests, payments } from "@/db/schema";
import { bookingSpecs } from "@/server/specs/bookings";
import { discountSpecs } from "@/server/specs/discounts";
import { paymentSpecs } from "@/server/specs/payments";
import { settingsSpecs } from "@/server/specs/settings";
import { failed, NOW, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { OWNER, signIn } from "./helpers/fixtures";
import { pgErrorCode } from "./helpers/pg-error";
import { p, paymentScenario, type PaymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE8_PLAN §4.1 through the action pipeline (BR-70..76, Q8-01..05, D-68): the phase 6
 * wedding on 2027-03-15 — 60,000, deposit 15,000, schedule 20,000 + 25,000 — confirmed with
 * the tiers 90 days → 75%, 30 → 50%, 0 → 0% on the deposit. After the confirmation the venue
 * changes its tiers to "0 days → 100%", which must not touch the booking.
 */

const TIERS_PLAN = [
  { minDaysBefore: "90", refundBps: "75" },
  { minDaysBefore: "30", refundBps: "50" },
  { minDaysBefore: "0", refundBps: "0" },
];

/** A Cairo noon on `date`: the instant the cancellation happens at. */
const at = (date: string) => new Date(`${date}T10:00:00Z`);

describe("cancellation (BR-70..76)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const policies = (s: PaymentScenario, extra: Record<string, unknown> = {}) =>
    s.call(
      settingsSpecs.updatePolicies,
      {
        minDepositType: "percent",
        minDepositValue: "25",
        cancellationBasis: "deposit",
        postponeCreditMode: "refund",
        tiers: TIERS_PLAN,
        ...extra,
      },
      s.owner.token,
    );

  /** The scenario with the plan's tiers, a confirmed wedding, then the venue's tiers changed behind it. */
  const setUp = async (basis: "deposit" | "total_paid" = "deposit") => {
    const s = await paymentScenario(handle);
    ok(await policies(s, { cancellationBasis: basis }));
    const a = await s.confirmed();
    ok(await policies(s, { tiers: [{ minDaysBefore: "0", refundBps: "100" }], cancellationBasis: "total_paid" }));
    return { s, a };
  };

  /** The owner signed in on `now`, for calls made that day. */
  const ownerOn = async (now: Date) => (await signIn(handle, OWNER.login, OWNER.password, now)).token;

  const preview = async (s: PaymentScenario, bookingId: string, now: Date) =>
    ok(await s.call(bookingSpecs.cancelPreview, { bookingId }, await ownerOn(now), now));

  const status = async (bookingId: string) =>
    (await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId)))[0].status;

  it("CN-01: by the snapshot's tiers (D-68), not the venue's new ones — 148 days → 75% of the deposit", async () => {
    const { s, a } = await setUp();
    const q = ok(await s.call(bookingSpecs.cancelPreview, { bookingId: a.id }, s.manager.token));
    expect(q).toMatchObject({
      status: "confirmed",
      daysRemaining: 148,
      refundBps: 7500,
      basisKind: "deposit",
      basis: p("15,000"),
      netPaid: p("15,000"),
      suggested: p("11,250"),
    });
  });

  it("CN-01..CN-03: the boundaries of each tier, in Cairo days (BR-70, BR-71)", async () => {
    const { s, a } = await setUp();
    expect((await preview(s, a.id, at("2026-12-15"))).suggested).toBe(p("11,250")); // 90 days
    expect((await preview(s, a.id, at("2026-12-16"))).suggested).toBe(p("7,500")); // 89
    expect((await preview(s, a.id, at("2027-02-13"))).suggested).toBe(p("7,500")); // 30
    expect((await preview(s, a.id, at("2027-02-14"))).suggested).toBe(0); // 29
    // CN-11: 22:30 UTC on 14 December is 00:30 on the 15th in Cairo — 90 days, not 91.
    expect((await preview(s, a.id, new Date("2026-12-14T22:30:00Z"))).daysRemaining).toBe(90);
  });

  it("CN-04: basis total_paid = the net paid — 15,000 + 20,000 → 75% = 26,250 (BR-72)", async () => {
    const { s, a } = await setUp("total_paid");
    ok(await s.call(paymentSpecs.record, { bookingId: a.id, amount: "20,000", methodId: s.cash }));
    expect((await preview(s, a.id, NOW)).suggested).toBe(p("26,250"));
  });

  it("CN-05: a voided deposit is left out, its replacement counts", async () => {
    const { s, a } = await setUp();
    ok(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "اتكتب غلط" }, s.manager.token));
    ok(
      await s.call(paymentSpecs.recordDeposit, {
        bookingId: a.id,
        amount: "10,000",
        methodId: s.cash,
        installments: [],
      }),
    );
    expect((await preview(s, a.id, NOW)).suggested).toBe(p("7,500"));
  });

  it("BR-74: cancelled with the suggested refund — one receipt, the status, the slot free, the audit with the numbers", async () => {
    const { s, a } = await setUp();
    const result = ok(
      await s.call(
        bookingSpecs.cancel,
        { bookingId: a.id, version: a.version, reason: "العريس سافر", refundAmount: "11,250", methodId: s.cash },
        s.manager.token,
      ),
    );
    expect(result).toMatchObject({ suggested: p("11,250"), retained: p("3,750") });
    expect(result.refund).toMatchObject({ amount: p("11,250") });
    const [row] = await db.select().from(bookings).where(eq(bookings.id, a.id));
    expect(row).toMatchObject({
      status: "cancelled",
      cancelReason: "العريس سافر",
      cancelledBy: s.manager.actor.userId,
      version: a.version + 1,
    });
    const refunds = await db.select().from(payments).where(eq(payments.bookingId, a.id));
    expect(refunds.filter((r) => r.kind === "refund")).toEqual([
      expect.objectContaining({ amount: p("11,250"), receiptNo: result.refund.receiptNo, note: "العريس سافر" }),
    ]);

    // CN-13: the slot is free at once (BR-74), the cancelled booking takes nothing more (Q8-03).
    const other = await s.confirmed();
    expect(other.id).not.toBe(a.id);
    expect(
      failed(await s.call(paymentSpecs.record, { bookingId: a.id, amount: "100", methodId: s.cash })),
    ).toMatchObject({ code: "BUSINESS_RULE_VIOLATION" });
    expect(
      failed(await s.call(paymentSpecs.void, { paymentId: a.depositId, reason: "تجربة" }, s.manager.token)).code,
    ).toBe("BUSINESS_RULE_VIOLATION");
    // The database refuses it too (0009).
    const error = await db
      .update(payments)
      .set({ voidedAt: NOW, voidedBy: s.owner.actor.userId, voidReason: "مباشر" })
      .where(eq(payments.id, a.depositId))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("42501");

    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.booking.displayStatus).toBe("cancelled");
    expect(page.money.ledger.paid).toBe(p("3,750"));
    expect(page.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(["bookings.cancel", "payments.record"]),
    );
    const [audit] = await db
      .select({ meta: auditLogs.meta })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "bookings.cancel"), eq(auditLogs.entityId, a.id)));
    expect(audit.meta).toMatchObject({
      daysRemaining: 148,
      refundBps: 7500,
      suggested: p("11,250"),
      refund: p("11,250"),
    });
  });

  it("CN-08: the amount up or down with a reason (BR-73), never above the net paid", async () => {
    const { s, a } = await setUp();
    const cancel = (extra: Record<string, unknown>) =>
      s.call(
        bookingSpecs.cancel,
        { bookingId: a.id, version: a.version, reason: "ظروف", methodId: s.cash, ...extra },
        s.manager.token,
      );
    expect(failed(await cancel({ refundAmount: "15,000" })).fieldErrors).toHaveProperty("adjustReason");
    expect(failed(await cancel({ refundAmount: "15,000.01", adjustReason: "رجعنا كله" })).rule).toBe("BR-73");
    expect(await status(a.id)).toBe("confirmed");
    const result = ok(await cancel({ refundAmount: "15,000", adjustReason: "رجعنا كله" }));
    expect(result).toMatchObject({ retained: 0 });
    const [refund] = await db.select().from(payments).where(eq(payments.id, result.refund.paymentId));
    expect(refund.note).toBe("رجعنا كله");
  });

  it("CN-08: zero instead of the suggestion, with a reason — no receipt, the venue keeps all", async () => {
    const { s, a } = await setUp();
    const result = ok(
      await s.call(
        bookingSpecs.cancel,
        {
          bookingId: a.id,
          version: a.version,
          reason: "ظروف",
          refundAmount: "0",
          adjustReason: "العقد اتفسخ من العميل",
        },
        s.manager.token,
      ),
    );
    expect(result).toMatchObject({ refund: null, retained: p("15,000") });
  });

  it("CN-09: a refund needs its method and payments.refund; refused, nothing is kept (BR-74)", async () => {
    const { s, a } = await setUp();
    const canceller = await s.staffWith("canceller", ["bookings.view", "bookings.cancel"]);
    const input = { bookingId: a.id, version: a.version, reason: "ظروف", refundAmount: "11,250" };
    expect(failed(await s.call(bookingSpecs.cancel, input, s.manager.token)).fieldErrors).toHaveProperty("methodId");
    expect(failed(await s.call(bookingSpecs.cancel, { ...input, methodId: s.cash }, canceller.token)).code).toBe(
      "FORBIDDEN",
    );
    // An inactive method fails after the checks — the transaction keeps nothing.
    ok(
      await s.call(
        settingsSpecs.setListItemActive,
        { kind: "paymentMethods", id: s.wallet, active: false },
        s.owner.token,
      ),
    );
    expect(failed(await s.call(bookingSpecs.cancel, { ...input, methodId: s.wallet }, s.manager.token)).code).not.toBe(
      undefined,
    );
    expect(await status(a.id)).toBe("confirmed");
    expect((await db.select().from(payments).where(eq(payments.bookingId, a.id))).length).toBe(1);
  });

  it("CN-12 / Q8-05: reception cancels a tentative booking (bookings.edit) but not a confirmed one; a tentative one refunds nothing (BR-75)", async () => {
    const { s, a } = await setUp();
    const t = await s.tentative({ eventDate: "2027-04-20" });
    expect(ok(await s.call(bookingSpecs.cancelPreview, { bookingId: t.id }))).toMatchObject({ status: "tentative" });
    expect(
      failed(
        await s.call(bookingSpecs.cancel, {
          bookingId: t.id,
          version: t.version,
          reason: "العميل اعتذر",
          refundAmount: "1",
        }),
      ).rule,
    ).toBe("BR-75");
    ok(await s.call(bookingSpecs.cancel, { bookingId: t.id, version: t.version, reason: "العميل اعتذر" }));
    expect(await status(t.id)).toBe("cancelled");
    // Again: cancelled is final (Q8-03).
    expect(
      failed(await s.call(bookingSpecs.cancel, { bookingId: t.id, version: t.version + 1, reason: "تاني" })).rule,
    ).toBe("BR-76");
    expect(
      failed(await s.call(bookingSpecs.cancel, { bookingId: a.id, version: a.version, reason: "ظروف" })).code,
    ).toBe("FORBIDDEN");
    expect(failed(await s.call(bookingSpecs.cancelPreview, { bookingId: a.id })).code).toBe("FORBIDDEN");
    expect(failed(await s.call(bookingSpecs.cancelPreview, { bookingId: a.id }, s.accountant.token)).code).toBe(
      "FORBIDDEN",
    );
  });

  it("CN-12: a confirmed party that is over is not cancelled (BR-76, D-54)", async () => {
    const { s, a } = await setUp();
    const after = new Date("2027-03-16T10:00:00Z");
    const result = await s.call(
      bookingSpecs.cancel,
      { bookingId: a.id, version: a.version, reason: "ظروف" },
      await ownerOn(after),
      after,
    );
    expect(failed(result)).toMatchObject({ rule: "BR-76" });
  });

  it("Q8-03: pending discount requests are withdrawn with the booking", async () => {
    const { s, a } = await setUp();
    const asked = ok(await s.call(discountSpecs.request, { bookingId: a.id, amount: "1,000", reason: "عميل قديم" }));
    const fresh = ok(await s.call(bookingSpecs.cancelPreview, { bookingId: a.id }, s.manager.token));
    ok(
      await s.call(
        bookingSpecs.cancel,
        { bookingId: a.id, version: fresh.version, reason: "ظروف", refundAmount: "11,250", methodId: s.cash },
        s.manager.token,
      ),
    );
    const [request] = await db.select().from(discountRequests).where(eq(discountRequests.id, asked.requestId));
    expect(request).toMatchObject({ status: "withdrawn", decidedBy: s.manager.actor.userId });
  });

  it("a version other than the one opened is refused (CONCURRENT_MODIFICATION)", async () => {
    const { s, a } = await setUp();
    const result = await s.call(
      bookingSpecs.cancel,
      { bookingId: a.id, version: a.version - 1, reason: "ظروف", refundAmount: "11,250", methodId: s.cash },
      s.manager.token,
    );
    expect(failed(result).code).toBe("CONCURRENT_MODIFICATION");
  });
});
