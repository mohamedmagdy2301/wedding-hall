import { periodProfit, listExpenses } from "@/modules/expenses/queries";
import { createExpenseSchema, listExpensesSchema, periodSchema, voidExpenseSchema } from "@/modules/expenses/schemas";
import { createExpense, voidExpense } from "@/modules/expenses/service";
import { defineProtected } from "./define";

/** API.md "Expenses" (phase 10, Q10-01..Q10-04). */
export const expenseSpecs = {
  list: defineProtected({
    schema: listExpensesSchema,
    requires: "expenses.view",
    handler: (ctx, input) => listExpenses(ctx.db, ctx.actor, input),
  }),
  create: defineProtected({
    schema: createExpenseSchema,
    requires: "expenses.record",
    handler: (ctx, input) => createExpense(ctx, ctx.actor, input),
  }),
  void: defineProtected({
    schema: voidExpenseSchema,
    requires: "expenses.void",
    handler: (ctx, input) => voidExpense(ctx, ctx.actor, input),
  }),
  summary: defineProtected({
    schema: periodSchema,
    requires: "reports.financial",
    handler: (ctx, input) => periodProfit(ctx.db, ctx.actor, input),
  }),
};
