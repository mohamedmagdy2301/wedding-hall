import { MAX_BPS } from "./money";

/**
 * The venue's cancellation tiers (D-20). Configured = at least one tier, 0% allowed (D-67).
 * Valid set (BR-77): distinct day counts within 0–730, refunds within 0–100%, and the
 * refund never decreases as the days before the party increase.
 */

export type CancellationTier = { minDaysBefore: number; refundBps: number };

export const MAX_TIER_DAYS = 730;
export const MAX_TIERS = 20;

export type TierViolation = "tiersRequired" | "tooManyTiers" | "tierOutOfRange" | "tierDaysDuplicate" | "tierOrder";

export const sortTiers = (tiers: readonly CancellationTier[]) =>
  [...tiers].sort((a, b) => a.minDaysBefore - b.minDaysBefore);

export function tierViolation(tiers: readonly CancellationTier[]): TierViolation | null {
  if (tiers.length === 0) return "tiersRequired";
  if (tiers.length > MAX_TIERS) return "tooManyTiers";
  const inRange = (t: CancellationTier) =>
    Number.isInteger(t.minDaysBefore) &&
    Number.isInteger(t.refundBps) &&
    t.minDaysBefore >= 0 &&
    t.minDaysBefore <= MAX_TIER_DAYS &&
    t.refundBps >= 0 &&
    t.refundBps <= MAX_BPS;
  if (!tiers.every(inRange)) return "tierOutOfRange";
  const sorted = sortTiers(tiers);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minDaysBefore === sorted[i - 1].minDaysBefore) return "tierDaysDuplicate";
    if (sorted[i].refundBps < sorted[i - 1].refundBps) return "tierOrder";
  }
  return null;
}

export const tiersConfigured = (tiers: readonly CancellationTier[]) => tiers.length > 0;

/** Every tier refunds 0%: the customer never gets anything back, so saving needs explicit confirmation (D-74). */
export const refundsNothing = (tiers: readonly CancellationTier[]) =>
  tiers.length > 0 && tiers.every((t) => t.refundBps === 0);

/**
 * BR-71: the tier with the largest `minDaysBefore` ≤ the days remaining; none → 0%.
 * In phase 8 it is applied to the booking's snapshot (D-68); here it drives the policy preview.
 */
export function tierFor(tiers: readonly CancellationTier[], daysRemaining: number): CancellationTier | null {
  let match: CancellationTier | null = null;
  for (const tier of sortTiers(tiers)) {
    if (tier.minDaysBefore <= daysRemaining) match = tier;
  }
  return match;
}

/**
 * The tiers as the contract states them (P-02, D-68), longest notice first: each tier covers
 * from its days up to the day before the next longer one (`toDays` is `null` for the longest).
 * Below the shortest tier nothing is refunded (no tier applies), so that range is added with 0.
 */
export function tierRanges(tiers: readonly CancellationTier[]) {
  const sorted = sortTiers(tiers).reverse();
  const ranges: { fromDays: number; toDays: number | null; refundBps: number }[] = sorted.map((tier, i) => ({
    fromDays: tier.minDaysBefore,
    toDays: i === 0 ? null : sorted[i - 1].minDaysBefore - 1,
    refundBps: tier.refundBps,
  }));
  const shortest = sorted.at(-1);
  if (shortest && shortest.minDaysBefore > 0) {
    ranges.push({ fromDays: 0, toDays: shortest.minDaysBefore - 1, refundBps: 0 });
  }
  return ranges;
}
