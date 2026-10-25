import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, bookings, expenses, payments } from "@/db/schema";
import { bookingExpenses } from "@/modules/expenses/queries";
import { bookingSpecs } from "@/server/specs/bookings";
import { expenseSpecs } from "@/server/specs/expenses";
import { paymentSpecs } from "@/server/specs/payments";
import { settingsSpecs } from "@/server/specs/settings";
import { failed, NOW, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { OWNER, signIn } from "./helpers/fixtures";
import { pgErrorCode } from "./helpers/pg-error";
import { p, paymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE9_PLAN §4 (EX-03..EX-07, Q10-01..Q10-04, D-50) through the action pipeline. The clock is
 * the scenario's 2026-10-18 13:00 Cairo. Booking A is confirmed with 15,000 and pays 10,000
 * more; booking B is confirmed with 15,000 and cancelled with 5,000 refunded (10,000 kept):
 * October's net collected is 40,000 − 5,000 = 35,000.
 */

describe("expenses and net profit (BR-95, BR-96, BR-97)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  async function setUp() {
    const s = await paymentScenario(handle);
    const category = async (name: string) =>
      ok(await s.call(settingsSpecs.createListItem, { kind: "expenseCategories", name }, s.owner.token)).id as string;
    const cleaning = await category("نظافة");
    const salaries = await category("مرتبات");
    const record = (input: Record<string, unknown>, token = s.accountant.token, now = NOW) =>
      s.call(
        expenseSpecs.create,
        { categoryId: cleaning, spentOn: "2026-10-18", description: "تنظيف القاعة", bookingNo: "", ...input },
        token,
        now,
      );
    return { ...s, cleaning, salaries, record };
  }

  async function october(s: Awaited<ReturnType<typeof setUp>>) {
    const a = await s.confirmed();
    ok(
      await s.call(
        paymentSpecs.record,
        { bookingId: a.id, amount: "10,000", methodId: s.cash, note: "" },
        s.reception.token,
      ),
    );
    const b = await s.confirmed("15,000", [], { eventDate: "2027-03-16" });
    ok(
      await s.call(
        bookingSpecs.cancel,
        {
          bookingId: b.id,
          version: b.version,
          reason: "العريس سافر",
          refundAmount: "5,000",
          methodId: s.cash,
          adjustReason: "اتفاق مع العميل",
        },
        s.manager.token,
      ),
    );
    return { a, b };
  }

  it("EX-03 / EX-05: 35,000 collected − 4,000 = 31,000; the cancelled booking's 10,000 kept counts, its net is 9,000", async () => {
    const s = await setUp();
    const { a, b } = await october(s);
    const first = ok(await s.record({ amount: "1,500.50", bookingNo: a.bookingNo }));
    ok(await s.record({ amount: "1,000", bookingNo: b.bookingNo, description: "تعويض المورد" }));
    const salary = ok(
      await s.record({ amount: "1,000", categoryId: s.salaries, description: "مرتب أكتوبر", spentOn: "2026-10-01" }),
    );
    ok(await s.record({ amount: "499.50", spentOn: "2026-10-05", description: "مستلزمات" }));

    const summary = ok(
      await s.call(expenseSpecs.summary, { from: "2026-10-01", to: "2026-10-31" }, s.accountant.token),
    );
    expect(summary).toEqual({ collected: p("35,000"), expenses: p("4,000"), net: p("31,000") });

    const list = ok(
      await s.call(
        expenseSpecs.list,
        { from: "2026-10-01", to: "2026-10-31", categoryId: "", bookingId: "" },
        s.manager.token,
      ),
    );
    expect(list.total).toBe(p("4,000"));
    expect(list.rows.map((r: { spentOn: string }) => r.spentOn)).toEqual([
      "2026-10-18",
      "2026-10-18",
      "2026-10-05",
      "2026-10-01",
    ]);

    // D-50 / Q10-03: the booking shows its expenses, and its net to reports.financial.
    const onB = await bookingExpenses(db, s.manager.actor, b.id);
    expect(onB).toMatchObject({
      total: p("1,000"),
      net: { collected: p("10,000"), expenses: p("1,000"), net: p("9,000") },
    });
    const onA = await bookingExpenses(db, s.accountant.actor, a.id);
    expect(onA).toMatchObject({ total: p("1,500.50"), net: { collected: p("25,000"), net: p("23,499.50") } });
    expect(onA?.rows).toMatchObject([{ id: first.id, bookingNo: a.bookingNo, categoryName: "نظافة" }]);
    const viewer = await s.staffWith("viewer", ["bookings.view", "expenses.view"]);
    expect((await bookingExpenses(db, viewer.actor, a.id))?.net).toBeNull();
    expect(await bookingExpenses(db, s.reception.actor, a.id)).toBeNull();

    // Q10-02: the expense never touches the booking's total or ledger.
    const [row] = await db.select({ total: bookings.total }).from(bookings).where(eq(bookings.id, a.id));
    expect(row.total).toBe(p("60,000"));
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.bookingId, a.id))).toHaveLength(2);

    // EX-02 / BR-95: voiding the 1,000 salary leaves 3,000 of expenses and 32,000 of profit.
    ok(await s.call(expenseSpecs.void, { expenseId: salary.id, reason: "اتسجل مرتين" }, s.manager.token));
    expect(ok(await s.call(expenseSpecs.summary, { from: "2026-10-01", to: "2026-10-31" }, s.manager.token))).toEqual({
      collected: p("35,000"),
      expenses: p("3,000"),
      net: p("32,000"),
    });
    const voided = ok(
      await s.call(
        expenseSpecs.list,
        { from: "2026-10-01", to: "2026-10-31", categoryId: s.salaries, bookingId: "" },
        s.manager.token,
      ),
    );
    expect(voided).toMatchObject({ total: 0, rows: [{ voidReason: "اتسجل مرتين", voidedByName: expect.any(String) }] });
  });

  it("EX-04: a period with expenses and no collections has a negative profit", async () => {
    const s = await setUp();
    await october(s);
    ok(
      await s.record({ amount: "3,000", spentOn: "2026-10-25" }, s.accountant.token, new Date("2026-10-25T09:00:00Z")),
    );
    const owner = await signIn(handle, OWNER.login, OWNER.password, new Date("2026-10-26T09:00:00Z"));
    const summary = ok(
      await s.call(
        expenseSpecs.summary,
        { from: "2026-10-19", to: "2026-10-31" },
        owner.token,
        new Date("2026-10-26T09:00:00Z"),
      ),
    );
    expect(summary).toEqual({ collected: 0, expenses: p("3,000"), net: -p("3,000") });
  });

  it("EX-06: the period's edges are Cairo days — 23:30 on 31 October is October, an expense of 1 November is not", async () => {
    const s = await setUp();
    const a = await s.confirmed();
    // Egypt is back on UTC+2 from 30 October 2026: 23:30 Cairo = 21:30 UTC.
    const lateOctober = new Date("2026-10-31T21:30:00Z");
    const owner = await signIn(handle, OWNER.login, OWNER.password, lateOctober);
    ok(
      await s.call(
        paymentSpecs.record,
        { bookingId: a.id, amount: "5,000", methodId: s.cash, note: "" },
        owner.token,
        lateOctober,
      ),
    );
    const november = new Date("2026-11-01T08:00:00Z");
    ok(await s.record({ amount: "700", spentOn: "2026-11-01" }, owner.token, november));

    const inOctober = ok(
      await s.call(expenseSpecs.summary, { from: "2026-10-01", to: "2026-10-31" }, owner.token, november),
    );
    expect(inOctober).toEqual({ collected: p("20,000"), expenses: 0, net: p("20,000") });
    const inNovember = ok(
      await s.call(expenseSpecs.summary, { from: "2026-11-01", to: "2026-11-30" }, owner.token, november),
    );
    expect(inNovember).toEqual({ collected: 0, expenses: p("700"), net: -p("700") });
  });

  it("EX-07: refuses 0, a negative amount, tomorrow, an inactive category, an unknown booking and voiding twice", async () => {
    const s = await setUp();
    const field = async (input: Record<string, unknown>) => {
      const error = failed(await s.record(input));
      expect(error.code).toBe("VALIDATION_ERROR");
      return Object.keys(error.fieldErrors ?? {});
    };
    expect(await field({ amount: "0" })).toEqual(["amount"]);
    expect(await field({ amount: "-50" })).toEqual(["amount"]);
    expect(await field({ amount: "100", spentOn: "2026-10-19" })).toEqual(["spentOn"]);
    expect(await field({ amount: "100", description: "x" })).toEqual(["description"]);
    expect(await field({ amount: "100", bookingNo: "2026-9999" })).toEqual(["bookingNo"]);
    ok(
      await s.call(
        settingsSpecs.setListItemActive,
        { kind: "expenseCategories", id: s.salaries, active: false },
        s.owner.token,
      ),
    );
    expect(await field({ amount: "100", categoryId: s.salaries })).toEqual(["categoryId"]);
    // Q10-01: an old day needs no extra permission.
    const old = ok(await s.record({ amount: "100", spentOn: "2025-01-31" }));

    // Permissions: the reception neither records nor lists; the accountant does not void.
    expect(failed(await s.record({ amount: "100" }, s.reception.token)).code).toBe("FORBIDDEN");
    expect(
      failed(await s.call(expenseSpecs.list, { from: "2026-10-01", to: "2026-10-31" }, s.reception.token)).code,
    ).toBe("FORBIDDEN");
    expect(failed(await s.call(expenseSpecs.void, { expenseId: old.id, reason: "غلط" }, s.accountant.token)).code).toBe(
      "FORBIDDEN",
    );
    expect(
      failed(await s.call(expenseSpecs.summary, { from: "2026-10-01", to: "2026-10-31" }, s.reception.token)).code,
    ).toBe("FORBIDDEN");
    expect(
      failed(await s.call(expenseSpecs.list, { from: "2026-10-31", to: "2026-10-01" }, s.manager.token)).fieldErrors,
    ).toHaveProperty("to");

    ok(await s.call(expenseSpecs.void, { expenseId: old.id, reason: "اتسجل غلط" }, s.manager.token));
    expect(
      failed(await s.call(expenseSpecs.void, { expenseId: old.id, reason: "تاني" }, s.manager.token)),
    ).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "BR-95",
    });
    const actions = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityType, "expense"));
    expect(actions.map((r) => r.action)).toEqual(["expenses.create", "expenses.void"]);
  });

  it("BR-95: the database refuses deleting an expense and any change but one void", async () => {
    const s = await setUp();
    const { id } = ok(await s.record({ amount: "100" }));
    const refused = async (work: Promise<unknown>) =>
      expect(
        pgErrorCode(
          await work.then(
            () => null,
            (e) => e,
          ),
        ),
      ).toBe("42501");
    await refused(db.delete(expenses).where(eq(expenses.id, id)));
    await refused(db.update(expenses).set({ amount: 1 }).where(eq(expenses.id, id)));
    ok(await s.call(expenseSpecs.void, { expenseId: id, reason: "اتسجل غلط" }, s.manager.token));
    await refused(db.update(expenses).set({ voidReason: "سبب تاني" }).where(eq(expenses.id, id)));
  });
});
