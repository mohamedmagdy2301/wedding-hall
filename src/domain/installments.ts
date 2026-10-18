import { addDays } from "@/lib/time";

/**
 * The installment schedule (BR-65, BR-66). Optional; when there is one, deposit + Σ
 * installments = total and the last one is due by the day before the party (D-33). Pure:
 * dates are Cairo calendar dates ("YYYY-MM-DD") and amounts integer piasters.
 */

export const MAX_INSTALLMENTS = 24;

export type ScheduleLine = { dueDate: string; amount: number };

/** By due date; lines due the same day keep their order. */
export const sortSchedule = <T extends ScheduleLine>(lines: readonly T[]): T[] =>
  [...lines].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

export const scheduleSum = (lines: readonly ScheduleLine[]) => lines.reduce((sum, l) => sum + l.amount, 0);

export type ScheduleViolation =
  | { violation: "tooManyInstallments" }
  | { violation: "installmentAmountInvalid"; index: number }
  | { violation: "installmentAfterEve"; index: number }
  | { violation: "scheduleSumMismatch"; difference: number };

/**
 * BR-65 for a schedule to save. `eventDate` is the party's start date in Cairo; an empty
 * schedule means none. `difference` = total − (deposit + Σ), what the schedule still misses.
 */
export function scheduleViolation(input: {
  total: number;
  deposit: number;
  eventDate: string;
  lines: readonly ScheduleLine[];
}): ScheduleViolation | null {
  const { lines } = input;
  if (lines.length === 0) return null;
  if (lines.length > MAX_INSTALLMENTS) return { violation: "tooManyInstallments" };
  const eve = addDays(input.eventDate, -1);
  for (const [index, line] of lines.entries()) {
    if (!Number.isSafeInteger(line.amount) || line.amount <= 0) return { violation: "installmentAmountInvalid", index };
    if (line.dueDate > eve) return { violation: "installmentAfterEve", index };
  }
  const difference = input.total - input.deposit - scheduleSum(lines);
  return difference === 0 ? null : { violation: "scheduleSumMismatch", difference };
}

/**
 * D-121 (with the product owner's addition): the schedule adjusted in the same operation so
 * that its sum becomes `targetSum` (total − the new deposit). An increase goes on the last
 * installment; a decrease comes off the newest first, then the ones before it, and no
 * installment drops below one piaster. `null` when that cannot reach the target — the staff
 * member then edits the schedule.
 */
export function rebalanceSchedule<T extends ScheduleLine>(lines: readonly T[], targetSum: number): T[] | null {
  const sorted = sortSchedule(lines);
  if (sorted.length === 0) return targetSum === 0 ? [] : null;
  const delta = targetSum - scheduleSum(sorted);
  const result = sorted.map((l) => ({ ...l }));
  if (delta >= 0) {
    result[result.length - 1].amount += delta;
    return result;
  }
  let toRemove = -delta;
  for (let i = result.length - 1; i >= 0 && toRemove > 0; i -= 1) {
    const take = Math.min(toRemove, result[i].amount - 1);
    result[i].amount -= take;
    toRemove -= take;
  }
  return toRemove === 0 ? result : null;
}

export type InstallmentState = "paid" | "upcoming" | "dueToday" | "overdue";

export type InstallmentStatus<T extends ScheduleLine> = T & {
  /** What this installment has of the paid amount, oldest installments first. */
  covered: number;
  outstanding: number;
  state: InstallmentState;
};

/**
 * BR-66, D-120: money covers the oldest lines first — the deposit, then the installments by
 * date — so installment k is covered once net paid ≥ total − Σ of the installments after it.
 * Overdue from the day after its date in Cairo (D-55) while not covered.
 */
export function installmentStatuses<T extends ScheduleLine>(
  total: number,
  lines: readonly T[],
  netPaid: number,
  todayCairo: string,
): InstallmentStatus<T>[] {
  const sorted = sortSchedule(lines);
  let after = scheduleSum(sorted);
  return sorted.map((line) => {
    after -= line.amount;
    const startsAt = total - after - line.amount;
    const covered = Math.max(0, Math.min(line.amount, netPaid - startsAt));
    const outstanding = line.amount - covered;
    const state: InstallmentState =
      outstanding === 0
        ? "paid"
        : line.dueDate < todayCairo
          ? "overdue"
          : line.dueDate === todayCairo
            ? "dueToday"
            : "upcoming";
    return { ...line, covered, outstanding, state };
  });
}
