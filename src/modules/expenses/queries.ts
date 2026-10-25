import { and, asc, desc, eq, gte, isNull, lt, lte, type SQL } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { bookings, expenseCategories, expenses, payments, users } from "@/db/schema";
import { profit, sumExpenses } from "@/domain/expenses";
import { addDays, cairoInstant } from "@/lib/time";
import type { SessionUser } from "@/modules/auth/sessions";
import type { DbOrTx } from "@/modules/shared/db";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import type { ListExpensesInput } from "./schemas";

/** S-11, the booking's expenses (D-50) and the period's net profit (BR-96, Q10-03). */

const voidedBy = aliasedTable(users, "voided_by_user");

const expenseColumns = {
  id: expenses.id,
  amount: expenses.amount,
  spentOn: expenses.spentOn,
  description: expenses.description,
  categoryName: expenseCategories.name,
  bookingId: expenses.bookingId,
  bookingNo: bookings.bookingNo,
  createdByName: users.name,
  createdAt: expenses.createdAt,
  voidedAt: expenses.voidedAt,
  voidedByName: voidedBy.name,
  voidReason: expenses.voidReason,
};

function selectExpenses(db: DbOrTx, where: SQL | undefined): Promise<ExpenseRow[]> {
  return db
    .select(expenseColumns)
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(users, eq(users.id, expenses.createdBy))
    .leftJoin(voidedBy, eq(voidedBy.id, expenses.voidedBy))
    .leftJoin(bookings, eq(bookings.id, expenses.bookingId))
    .where(where)
    .orderBy(desc(expenses.spentOn), desc(expenses.createdAt));
}

export type ExpenseRow = {
  id: string;
  amount: number;
  spentOn: string;
  description: string;
  categoryName: string;
  bookingId: string | null;
  bookingNo: string | null;
  createdByName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
};

const totalOf = (rows: readonly ExpenseRow[]) => sumExpenses(rows.map((r) => ({ ...r, voided: r.voidedAt !== null })));

export async function listExpenses(db: DbOrTx, actor: SessionUser, filters: ListExpensesInput) {
  assertAllowed(actor, "expenses.view");
  const rows = await selectExpenses(
    db,
    and(
      eq(expenses.venueId, actor.venueId),
      gte(expenses.spentOn, filters.from),
      lte(expenses.spentOn, filters.to),
      filters.categoryId ? eq(expenses.categoryId, filters.categoryId) : undefined,
      filters.bookingId ? eq(expenses.bookingId, filters.bookingId) : undefined,
    ),
  );
  return { rows, total: totalOf(rows) };
}

/** Collections and refunds whose payment time falls on the Cairo days `from`..`to` (EX-06). */
async function periodLedger(db: DbOrTx, venueId: string, from: string, to: string) {
  const rows = await db
    .select({ kind: payments.kind, amount: payments.amount })
    .from(payments)
    .where(
      and(
        eq(payments.venueId, venueId),
        isNull(payments.voidedAt),
        gte(payments.paidAt, cairoInstant(from, "00:00")),
        lt(payments.paidAt, cairoInstant(addDays(to, 1), "00:00")),
      ),
    );
  return rows.map((r) => ({ ...r, voided: false }));
}

/**
 * BR-96 for a period (`reports.financial`): net collected (BR-97 — what the venue kept from
 * cancelled bookings included) − expenses, by payment time and expense day in Cairo.
 */
export async function periodProfit(db: DbOrTx, actor: SessionUser, period: { from: string; to: string }) {
  assertAllowed(actor, "reports.financial");
  const ledger = await periodLedger(db, actor.venueId, period.from, period.to);
  const spent = await db
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(
      and(
        eq(expenses.venueId, actor.venueId),
        isNull(expenses.voidedAt),
        gte(expenses.spentOn, period.from),
        lte(expenses.spentOn, period.to),
      ),
    );
  return profit(
    ledger,
    spent.map((e) => ({ ...e, voided: false })),
  );
}

export type BookingExpenses = {
  rows: ExpenseRow[];
  total: number;
  /** Only for `reports.financial` (Q10-03): the booking's net collected − its expenses. */
  net: { collected: number; expenses: number; net: number } | null;
};

/** S-07 "ملخص" (D-50): `null` without `expenses.view`. */
export async function bookingExpenses(
  db: DbOrTx,
  actor: SessionUser,
  bookingId: string,
): Promise<BookingExpenses | null> {
  if (!satisfies(actor, "expenses.view")) return null;
  const rows = await selectExpenses(db, and(eq(expenses.venueId, actor.venueId), eq(expenses.bookingId, bookingId)));
  let net: BookingExpenses["net"] = null;
  if (satisfies(actor, "reports.financial")) {
    const ledger = await db
      .select({ kind: payments.kind, amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.bookingId, bookingId), isNull(payments.voidedAt)))
      .orderBy(asc(payments.receiptNo));
    net = profit(
      ledger.map((r) => ({ ...r, voided: false })),
      rows.map((r) => ({ ...r, voided: r.voidedAt !== null })),
    );
  }
  return { rows, total: totalOf(rows), net };
}

/** The active categories for the add form; the filter lists inactive ones too. */
export async function expenseCategoryOptions(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "expenses.view");
  return db
    .select({ id: expenseCategories.id, name: expenseCategories.name, isActive: expenseCategories.isActive })
    .from(expenseCategories)
    .where(eq(expenseCategories.venueId, actor.venueId))
    .orderBy(asc(expenseCategories.name));
}
