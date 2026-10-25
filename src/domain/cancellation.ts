import { tierFor, type CancellationTier } from "./cancellation-tiers";
import { addDays } from "@/lib/time";
import { rebalanceSchedule, scheduleSum, sortSchedule, type ScheduleLine } from "./installments";
import { applyBps } from "./money";
import { netPaid, type LedgerEntry } from "./payments";

/**
 * Cancelling a confirmed booking (BR-70..73, D-68) and the schedule a postponement suggests
 * (BR-84). Pure: dates are Cairo calendar dates ("YYYY-MM-DD"), amounts integer piasters.
 */

const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** BR-70: the party's date − the cancellation date, in whole Cairo days (negative once it started). */
export const daysRemaining = (eventDate: string, cancelDate: string) => dayNumber(eventDate) - dayNumber(cancelDate);

export type CancellationQuote = {
  daysRemaining: number;
  /** The tier applied, from the booking's snapshot (BR-71); null = none matches, 0%. */
  tier: CancellationTier | null;
  refundBps: number;
  /** BR-72: Σ active deposits, or the net paid, by the snapshot's basis (P8-02). */
  basis: number;
  netPaid: number;
  /** basis × the tier's share (half up — D-96), never above the net paid (P8-01). */
  suggested: number;
};

export function cancellationQuote(input: {
  tiers: readonly CancellationTier[];
  basis: "deposit" | "total_paid";
  ledger: readonly LedgerEntry[];
  eventDate: string;
  cancelDate: string;
}): CancellationQuote {
  const days = daysRemaining(input.eventDate, input.cancelDate);
  const tier = tierFor(input.tiers, days);
  const refundBps = tier?.refundBps ?? 0;
  const paid = netPaid(input.ledger);
  const basis =
    input.basis === "deposit"
      ? input.ledger.filter((e) => e.kind === "deposit" && !e.voided).reduce((s, e) => s + e.amount, 0)
      : Math.max(0, paid);
  const suggested = Math.min(applyBps(basis, refundBps), Math.max(0, paid));
  return { daysRemaining: days, tier, refundBps, basis, netPaid: paid, suggested };
}

/**
 * BR-84 (Q8-06): the schedule a postponement to `eventDate` suggests. Installments due after
 * its eve become one installment on the eve; the sum is then brought to `targetSum` (the new
 * total − the deposit) like D-121. Null when no schedule can reach it (BR-63's case).
 */
export function postponedSchedule(
  lines: readonly ScheduleLine[],
  eventDate: string,
  targetSum: number,
): ScheduleLine[] | null {
  const eve = addDays(eventDate, -1);
  const kept = sortSchedule(lines).filter((l) => l.dueDate <= eve);
  const late = scheduleSum(lines) - scheduleSum(kept);
  const folded = kept.map((l) => ({ ...l }));
  if (late > 0) {
    const last = folded[folded.length - 1];
    if (last && last.dueDate === eve) last.amount += late;
    else folded.push({ dueDate: eve, amount: late });
  }
  if (folded.length === 0) return targetSum === 0 ? [] : null;
  return rebalanceSchedule(folded, targetSum);
}

/** BR-84: installments due after the eve of the new date, which the staff member must move first. */
export const lateInstallments = (lines: readonly ScheduleLine[], eventDate: string) =>
  lines.filter((l) => l.dueDate > addDays(eventDate, -1));
