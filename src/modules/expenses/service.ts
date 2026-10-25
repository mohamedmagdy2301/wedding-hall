import { and, eq } from "drizzle-orm";
import { bookings, expenseCategories, expenses } from "@/db/schema";
import { cairoDate } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import { AppError, notFound } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import type { CreateExpenseInput, VoidExpenseInput } from "./schemas";

/**
 * Recording and voiding expenses (BR-95, UF-10, Q10-01..Q10-04). An expense is the venue's: a
 * linked booking only shows it, its total and ledger never change (Q10-02).
 */

const fieldError = (field: string, key: string) =>
  new AppError("VALIDATION_ERROR", key, { fieldErrors: { [field]: key } });

export async function createExpense(deps: ServiceDeps, actor: SessionUser, input: CreateExpenseInput) {
  assertAllowed(actor, "expenses.record");
  const venueId = actor.venueId;
  // Q10-01: any day up to today in Cairo; a past day needs no extra permission.
  if (input.spentOn > cairoDate(deps.now)) throw fieldError("spentOn", "spentOnFuture");
  return runTransaction(deps.db, async (tx) => {
    const [category] = await tx
      .select({ name: expenseCategories.name, isActive: expenseCategories.isActive })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, input.categoryId), eq(expenseCategories.venueId, venueId)));
    if (!category) throw fieldError("categoryId", "expenseCategoryNotFound");
    if (!category.isActive) throw fieldError("categoryId", "expenseCategoryInactive");

    let booking: { id: string; bookingNo: string } | null = null;
    if (input.bookingNo) {
      // Q10-02: any status — tentative, confirmed or cancelled.
      [booking] = await tx
        .select({ id: bookings.id, bookingNo: bookings.bookingNo })
        .from(bookings)
        .where(and(eq(bookings.bookingNo, input.bookingNo), eq(bookings.venueId, venueId)));
      if (!booking) throw fieldError("bookingNo", "expenseBookingNotFound");
    }

    const [row] = await tx
      .insert(expenses)
      .values({
        venueId,
        categoryId: input.categoryId,
        bookingId: booking?.id ?? null,
        amount: input.amount,
        spentOn: input.spentOn,
        description: input.description,
        createdBy: actor.userId,
      })
      .returning({ id: expenses.id });
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "expenses.create",
      entityType: "expense",
      entityId: row.id,
      after: {
        category: category.name,
        amount: input.amount,
        spentOn: input.spentOn,
        description: input.description,
        bookingNo: booking?.bookingNo ?? null,
      },
      meta: booking ? { bookingId: booking.id } : undefined,
    });
    return { id: row.id };
  });
}

/** BR-95, Q10-04: voided once with a reason; a wrong expense is voided and recorded again. */
export async function voidExpense(deps: ServiceDeps, actor: SessionUser, input: VoidExpenseInput) {
  assertAllowed(actor, "expenses.void");
  await runTransaction(deps.db, async (tx) => {
    const [expense] = await tx
      .select({
        amount: expenses.amount,
        spentOn: expenses.spentOn,
        description: expenses.description,
        bookingId: expenses.bookingId,
        voidedAt: expenses.voidedAt,
      })
      .from(expenses)
      .where(and(eq(expenses.id, input.expenseId), eq(expenses.venueId, actor.venueId)))
      .for("update");
    if (!expense) throw notFound("expenseNotFound");
    if (expense.voidedAt) throw new AppError("BUSINESS_RULE_VIOLATION", "expenseAlreadyVoided", { rule: "BR-95" });
    await tx
      .update(expenses)
      .set({ voidedAt: deps.now, voidedBy: actor.userId, voidReason: input.reason })
      .where(eq(expenses.id, input.expenseId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "expenses.void",
      entityType: "expense",
      entityId: input.expenseId,
      before: { amount: expense.amount, spentOn: expense.spentOn, description: expense.description },
      after: { voidReason: input.reason },
      meta: expense.bookingId ? { bookingId: expense.bookingId } : undefined,
    });
  });
}
