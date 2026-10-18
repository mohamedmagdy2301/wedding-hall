/**
 * The overlap test of `bookings_no_overlap` (BR-11): same space and
 * `tstzrange(starts_at, blocked_until, '[)') &&`. Half-open, so a booking may start exactly
 * when the previous one's buffer ends (BR-10). The database constraint is the guarantee;
 * this mirror is for warnings and the calendar only (CLAUDE.md rule 3).
 */

export type BlockedRange = { startsAt: Date; blockedUntil: Date };

export const rangesOverlap = (a: BlockedRange, b: BlockedRange) =>
  a.startsAt < b.blockedUntil && b.startsAt < a.blockedUntil;

/** BR-26 (D-42): `YYYY-NNNN`, at least four digits. */
export const bookingNumber = (year: number, n: number) => `${year}-${String(n).padStart(4, "0")}`;
