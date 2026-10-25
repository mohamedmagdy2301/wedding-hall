import { netPaid, type LedgerEntry } from "./payments";

/**
 * Expenses and net profit (BR-95, BR-96, Q10-03, P9-09). Pure: the callers read the rows.
 * A voided expense counts for nothing, like a voided payment.
 */

export type ExpenseEntry = { amount: number; voided: boolean };

export const sumExpenses = (entries: readonly ExpenseEntry[]) =>
  entries.reduce((sum, e) => (e.voided ? sum : sum + e.amount), 0);

/**
 * BR-96: net collected − expenses. Collected is the payments ledger of the period (collections
 * − refunds, not voided), which includes what the venue kept from a cancelled booking (BR-97,
 * D-53). Negative when the expenses are larger.
 */
export function profit(payments: readonly LedgerEntry[], expenses: readonly ExpenseEntry[]) {
  const collected = netPaid(payments);
  const spent = sumExpenses(expenses);
  return { collected, expenses: spent, net: collected - spent };
}
