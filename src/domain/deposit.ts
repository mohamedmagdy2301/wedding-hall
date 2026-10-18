import { applyBps } from "./money";

/**
 * The minimum deposit to confirm a booking (BR-21 item 1, D-119), on its total after the
 * re-pricing at confirmation: a percentage rounds once, half up (D-96); a fixed amount above
 * the total asks for the total; without a minimum any positive deposit does. The deposit
 * never exceeds the total (BR-63).
 */

export type DepositPolicy = { minDepositType: "none" | "fixed" | "percent"; minDepositValue: number };

export function minimumDeposit(total: number, policy: DepositPolicy): number {
  switch (policy.minDepositType) {
    case "none":
      return 0;
    case "fixed":
      return Math.min(policy.minDepositValue, total);
    case "percent":
      return applyBps(total, policy.minDepositValue);
  }
}

export type DepositViolation = "depositRequired" | "depositBelowMinimum" | "depositExceedsTotal";

export function depositViolation(total: number, policy: DepositPolicy, amount: number): DepositViolation | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return "depositRequired";
  if (amount > total) return "depositExceedsTotal";
  if (amount < minimumDeposit(total, policy)) return "depositBelowMinimum";
  return null;
}
