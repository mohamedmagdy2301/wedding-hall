import { addDays, addYears, cairoDate, cairoInstant, MINUTE_MS } from "@/lib/time";
import type { SlotKind } from "./catalog";
import { fullDay, toMinutes, type SlotTimes, type SpaceSlotTimes } from "./slots";

/**
 * A booking's instants from its Cairo date, slot and typed times (BR-03, BR-04, BR-10,
 * D-37, D-100). Pure: the space's slots, the buffer and "now" are passed in.
 */

export const MAX_BOOKING_MINUTES = 24 * 60;
/** How far ahead a new booking may be dated (BR-27, D-109). */
export const MAX_YEARS_AHEAD = 3;

export type BookingTimesInput = {
  eventDate: string; // YYYY-MM-DD in Cairo = the date of starts_at (BR-04)
  slotKind: SlotKind;
  slots: SpaceSlotTimes;
  /** "HH:MM"; empty = the slot's default (BR-04: a small adjustment keeps slot and price). */
  startTime?: string | null;
  endTime?: string | null;
  bufferMinutes: number;
};

export type BookingTimes = {
  startTime: string;
  endTime: string;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  /** Real minutes between start and end (summer-time nights are 23 or 25 hours long). */
  minutes: number;
};

export type BookingTimesViolation =
  | "sameStartEnd" // end = start is zero or 24 hours: refused (D-100)
  | "endBeforeStart" // only when the start falls in the hour skipped by summer time
  | "tooLong"; // more than 24 real hours (BR-04, D-37)

/** The default times of a slot; the full day runs from the day start to the evening end (BR-01). */
export function defaultSlotTimes(slots: SpaceSlotTimes, slotKind: SlotKind): SlotTimes {
  if (slotKind === "full_day") {
    const { start, end } = fullDay(slots);
    return { start, end };
  }
  return slots[slotKind];
}

/**
 * The start is always on the event date; an end earlier than the start is on the next day
 * (an evening past midnight). `blocked_until = ends_at + buffer` in real minutes (BR-10).
 */
export function bookingTimes(
  input: BookingTimesInput,
): { ok: true; times: BookingTimes } | { ok: false; violation: BookingTimesViolation } {
  const defaults = defaultSlotTimes(input.slots, input.slotKind);
  const startTime = input.startTime || defaults.start;
  const endTime = input.endTime || defaults.end;
  const startMinutes = toMinutes(startTime);
  const endMinutes = toMinutes(endTime);
  if (startMinutes === endMinutes) return { ok: false, violation: "sameStartEnd" };

  const endDate = endMinutes < startMinutes ? addDays(input.eventDate, 1) : input.eventDate;
  const startsAt = cairoInstant(input.eventDate, startTime);
  const endsAt = cairoInstant(endDate, endTime);
  const minutes = (endsAt.getTime() - startsAt.getTime()) / MINUTE_MS;
  if (minutes <= 0) return { ok: false, violation: "endBeforeStart" };
  if (minutes > MAX_BOOKING_MINUTES) return { ok: false, violation: "tooLong" };

  const blockedUntil = new Date(endsAt.getTime() + input.bufferMinutes * MINUTE_MS);
  return { ok: true, times: { startTime, endTime, startsAt, endsAt, blockedUntil, minutes } };
}

/**
 * D-111: adjusted times that run into the other slot's default hours on the same date keep
 * the chosen slot's price — the screen warns about it. The full day covers both slots.
 */
export function intrudesOtherSlot(
  times: Pick<BookingTimes, "startsAt" | "endsAt">,
  slotKind: SlotKind,
  slots: SpaceSlotTimes,
  eventDate: string,
): boolean {
  if (slotKind === "day") return times.endsAt > cairoInstant(eventDate, slots.evening.start);
  if (slotKind === "evening") return times.startsAt < cairoInstant(eventDate, slots.day.end);
  return false;
}

export type BookingDateViolation = "datePassed" | "dateTooFar" | "startPassed";

/** BR-27 (D-109): from today (Cairo) to three years ahead, starting after now. */
export function bookingDateViolation(eventDate: string, startsAt: Date, now: Date): BookingDateViolation | null {
  const today = cairoDate(now);
  if (eventDate < today) return "datePassed";
  if (eventDate > addYears(today, MAX_YEARS_AHEAD)) return "dateTooFar";
  if (startsAt <= now) return "startPassed";
  return null;
}
