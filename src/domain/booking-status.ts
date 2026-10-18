/**
 * Booking statuses (BUSINESS_RULES §3). Stored: tentative, confirmed, cancelled. Shown:
 * also expired, conflicting and completed — computed at read time, never stored (T-13,
 * ADR-007). Pure: "now" and the overlap with a confirmed booking are passed in.
 */

export const BOOKING_STATUSES = ["tentative", "confirmed", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const DISPLAY_STATUSES = ["tentative", "conflicting", "expired", "confirmed", "completed", "cancelled"] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export type StatusFacts = {
  status: BookingStatus;
  tentativeExpiresAt: Date | null;
  endsAt: Date;
};

/**
 * In this order: cancelled; a confirmed booking is completed from its end (BR-24); a
 * tentative one is expired from `tentative_expires_at` — expiry before conflict (D-104) —
 * then conflicting when it overlaps a confirmed booking (BR-13).
 */
export function displayStatus(booking: StatusFacts, now: Date, overlapsConfirmed: boolean): DisplayStatus {
  if (booking.status === "cancelled") return "cancelled";
  if (booking.status === "confirmed") return now >= booking.endsAt ? "completed" : "confirmed";
  if (booking.tentativeExpiresAt && now >= booking.tentativeExpiresAt) return "expired";
  return overlapsConfirmed ? "conflicting" : "tentative";
}

/** A tentative booking still holds its place in lists and warnings until it expires. */
export const isLiveTentative = (booking: StatusFacts, now: Date) =>
  booking.status === "tentative" && !!booking.tentativeExpiresAt && now < booking.tentativeExpiresAt;
