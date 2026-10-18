/**
 * The payments ledger (BR-62): paid = Σ collections not voided − Σ refunds not voided, and
 * remaining = total − paid. Nothing of it is stored (CLAUDE.md rule 5); every screen and
 * receipt computes it from the rows.
 */

export const PAYMENT_KINDS = ["deposit", "installment", "payment", "refund"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export type LedgerEntry = { kind: PaymentKind; amount: number; voided: boolean };

const signed = (e: Pick<LedgerEntry, "kind" | "amount">) => (e.kind === "refund" ? -e.amount : e.amount);

export function netPaid(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, e) => (e.voided ? sum : sum + signed(e)), 0);
}

export function ledger(total: number, entries: readonly LedgerEntry[]) {
  const paid = netPaid(entries);
  return { total, paid, remaining: total - paid };
}

/** BR-63: no payment may take the paid amount above the total. */
export const exceedsTotal = (total: number, paid: number, amount: number) => paid + amount > total;

/** A deposit not voided is the booking's deposit (BR-60, D-40). */
export const activeDeposit = <T extends LedgerEntry>(entries: readonly T[]): T | undefined =>
  entries.find((e) => e.kind === "deposit" && !e.voided);

/** BR-61, D-125: the venue's running number, six digits at least. */
export const formatReceiptNo = (n: number) => String(n).padStart(6, "0");

export type ReceiptEntry = {
  receiptNo: string;
  kind: PaymentKind;
  amount: number;
  createdAt: Date;
  voidedAt: Date | null;
};

/**
 * Paid as of a receipt's issuance (D-122): the booking's payments up to this receipt by
 * number — not by payment date, so a backdated payment counts from when it was recorded —
 * leaving out those voided before it was issued. The receipt itself counts even if voided
 * later, so a reprint always shows the same numbers.
 */
export function paidAsOfReceipt(entries: readonly ReceiptEntry[], receiptNo: string): number {
  const target = entries.find((e) => e.receiptNo === receiptNo);
  if (!target) throw new RangeError(`unknown receipt ${receiptNo}`);
  const upTo = Number(receiptNo);
  return entries.reduce((sum, e) => {
    if (Number(e.receiptNo) > upTo) return sum;
    if (e !== target && e.voidedAt && e.voidedAt <= target.createdAt) return sum;
    return sum + signed(e);
  }, 0);
}
