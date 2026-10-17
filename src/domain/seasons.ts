import { cairoDate } from "@/lib/time";

/**
 * Seasons are inclusive date ranges (YYYY-MM-DD) that never overlap while active (BR-31;
 * enforced by `seasons_no_overlap`, mirrored here to explain the conflict before saving).
 * ISO dates compare correctly as strings.
 */

export type SeasonRange = { id?: string; name?: string; startDate: string; endDate: string; isActive?: boolean };

export const rangesOverlap = (a: SeasonRange, b: SeasonRange) => a.startDate <= b.endDate && b.startDate <= a.endDate;

/** The first active season (other than the candidate itself) that the candidate overlaps. */
export function findOverlap<T extends SeasonRange>(candidate: SeasonRange, seasons: readonly T[]): T | undefined {
  return seasons.find((s) => s.isActive !== false && s.id !== candidate.id && rangesOverlap(candidate, s));
}

/** The active season containing a Cairo calendar date, if any (BR-31). */
export function seasonForDate<T extends SeasonRange>(seasons: readonly T[], date: string): T | undefined {
  return seasons.find((s) => s.isActive !== false && s.startDate <= date && date <= s.endDate);
}

/** The season of a party is decided by its start in Cairo time, not the server's (BR-31, T-16). */
export function seasonForInstant<T extends SeasonRange>(seasons: readonly T[], startsAt: Date): T | undefined {
  return seasonForDate(seasons, cairoDate(startsAt));
}
