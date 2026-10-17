/**
 * The two default slots of a space (BR-01) and their constraints with the venue buffer
 * (BR-02, D-69). Times of day are "HH:MM" (seconds ignored), handled as minutes since midnight.
 */

export const MINUTES_PER_DAY = 24 * 60;

export type SlotTimes = { start: string; end: string };
export type SpaceSlotTimes = { day: SlotTimes; evening: SlotTimes };

export type SlotViolation =
  | "dayCrossesMidnight" // the day slot must end after it starts, on the same day
  | "zeroLength" // a slot cannot start and end at the same minute
  | "eveningTooEarly" // day end + buffer must not pass the evening start
  | "eveningIntoNextDay"; // evening end + buffer must not pass the next day's day start

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

export function isTimeOfDay(text: string): boolean {
  return TIME.test(text);
}

export function toMinutes(time: string): number {
  const match = TIME.exec(time);
  if (!match) throw new Error(`invalid time of day: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since midnight → "HH:MM". */
export function fromMinutes(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "HH:MM:SS" from the database → "HH:MM". */
export const toHhMm = (time: string) => fromMinutes(toMinutes(time));

/** Minute offsets from the day start: the evening end is past 1440 when it crosses midnight. */
function timeline(slots: SpaceSlotTimes) {
  const dayStart = toMinutes(slots.day.start);
  const dayEnd = toMinutes(slots.day.end);
  const eveningStart = toMinutes(slots.evening.start);
  const eveningEndRaw = toMinutes(slots.evening.end);
  const eveningEnd = eveningEndRaw < eveningStart ? eveningEndRaw + MINUTES_PER_DAY : eveningEndRaw;
  return { dayStart, dayEnd, eveningStart, eveningEnd };
}

export const crossesMidnight = (slot: SlotTimes) => toMinutes(slot.end) < toMinutes(slot.start);

/** Every BR-01/BR-02 violation of a space's slots with the given buffer (empty = valid). */
export function slotViolations(slots: SpaceSlotTimes, bufferMinutes: number): SlotViolation[] {
  const violations: SlotViolation[] = [];
  const { dayStart, dayEnd, eveningStart, eveningEnd } = timeline(slots);
  if (dayStart === dayEnd || eveningStart === eveningEnd) violations.push("zeroLength");
  if (dayEnd < dayStart) violations.push("dayCrossesMidnight");
  if (dayEnd + bufferMinutes > eveningStart) violations.push("eveningTooEarly");
  if (eveningEnd + bufferMinutes > dayStart + MINUTES_PER_DAY) violations.push("eveningIntoNextDay");
  return violations;
}

/**
 * The largest buffer these slots allow (D-51): the smaller of the two gaps. Null when the
 * slots are invalid regardless of the buffer.
 */
export function maxBufferFor(slots: SpaceSlotTimes): number | null {
  if (slotViolations(slots, 0).length > 0) return null;
  const { dayStart, dayEnd, eveningStart, eveningEnd } = timeline(slots);
  return Math.min(eveningStart - dayEnd, dayStart + MINUTES_PER_DAY - eveningEnd);
}

/** The full-day slot = day start → evening end (BR-01), with its length in minutes. */
export function fullDay(slots: SpaceSlotTimes): SlotTimes & { minutes: number } {
  const { dayStart, eveningEnd } = timeline(slots);
  return { start: fromMinutes(dayStart), end: fromMinutes(eveningEnd), minutes: eveningEnd - dayStart };
}
