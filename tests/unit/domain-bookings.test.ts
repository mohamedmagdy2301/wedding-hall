import { describe, expect, it } from "vitest";
import { bookingNumber, rangesOverlap, type BlockedRange } from "@/domain/booking-overlap";
import { displayStatus, isLiveTentative, type StatusFacts } from "@/domain/booking-status";
import { bookingDateViolation, bookingTimes, intrudesOtherSlot, type BookingTimesInput } from "@/domain/booking-time";
import type { SpaceSlotTimes } from "@/domain/slots";
import { cairoInstant, cairoTimeOfDay, cairoYear } from "@/lib/time";

/**
 * PHASE5_PLAN §9.2: booking times (T-01..T-16), display statuses (S-01..S-07), the overlap
 * mirror and numbering. Expected instants are written by hand in UTC (Cairo is +02:00 in
 * winter, +03:00 in summer time — last Friday of April to last Thursday of October).
 */

// Space A of §9.1: day 13:00–18:00, evening 20:00–01:00 (past midnight), buffer 60.
const SLOTS: SpaceSlotTimes = { day: { start: "13:00", end: "18:00" }, evening: { start: "20:00", end: "01:00" } };

function times(input: Partial<BookingTimesInput> = {}) {
  const result = bookingTimes({
    eventDate: "2027-01-15",
    slotKind: "evening",
    slots: SLOTS,
    bufferMinutes: 60,
    ...input,
  });
  if (!result.ok) throw new Error(result.violation);
  const { startsAt, endsAt, blockedUntil, minutes } = result.times;
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    blockedUntil: blockedUntil.toISOString(),
    minutes,
  };
}

const violation = (input: Partial<BookingTimesInput>) => {
  const result = bookingTimes({
    eventDate: "2027-01-15",
    slotKind: "evening",
    slots: SLOTS,
    bufferMinutes: 60,
    ...input,
  });
  return result.ok ? null : result.violation;
};

describe("booking times (BR-03, BR-04, BR-10, D-37, D-100)", () => {
  it("T-01: the day slot on 2027-01-15", () => {
    expect(times({ slotKind: "day" })).toEqual({
      startsAt: "2027-01-15T11:00:00.000Z",
      endsAt: "2027-01-15T16:00:00.000Z",
      blockedUntil: "2027-01-15T17:00:00.000Z",
      minutes: 300,
    });
  });

  it("T-02: the evening slot ends after midnight, on the next day (BR-03)", () => {
    expect(times()).toEqual({
      startsAt: "2027-01-15T18:00:00.000Z",
      endsAt: "2027-01-15T23:00:00.000Z", // 01:00 on the 16th in Cairo
      blockedUntil: "2027-01-16T00:00:00.000Z", // 02:00 on the 16th
      minutes: 300,
    });
  });

  it("T-03: the full day runs from the day start to the evening end (BR-01)", () => {
    expect(times({ slotKind: "full_day" })).toMatchObject({
      startsAt: "2027-01-15T11:00:00.000Z",
      endsAt: "2027-01-15T23:00:00.000Z",
      minutes: 12 * 60,
    });
  });

  it("T-04: an evening in summer time (+03:00)", () => {
    expect(times({ eventDate: "2027-07-10" })).toMatchObject({
      startsAt: "2027-07-10T17:00:00.000Z",
      endsAt: "2027-07-10T22:00:00.000Z",
    });
  });

  it("T-05: the night summer time ends (2027-10-28) lasts 6 real hours", () => {
    expect(times({ eventDate: "2027-10-28" })).toEqual({
      startsAt: "2027-10-28T17:00:00.000Z", // 20:00 +03
      endsAt: "2027-10-28T23:00:00.000Z", // 01:00 +02 on the 29th
      blockedUntil: "2027-10-29T00:00:00.000Z",
      minutes: 360,
    });
  });

  it("T-06: the night summer time starts (2027-04-29) lasts 4 real hours", () => {
    expect(times({ eventDate: "2027-04-29" })).toMatchObject({
      startsAt: "2027-04-29T18:00:00.000Z", // 20:00 +02
      endsAt: "2027-04-29T22:00:00.000Z", // 01:00 +03 on the 30th
      minutes: 240,
    });
  });

  it("T-07: a time skipped by summer time moves forward by the gap (00:30 → 01:30 +03), like PostgreSQL", () => {
    expect(cairoInstant("2027-04-30", "00:30").toISOString()).toBe("2027-04-29T22:30:00.000Z");
    expect(cairoTimeOfDay(cairoInstant("2027-04-30", "00:30"))).toBe("01:30");
  });

  it("T-08: a time repeated when summer time ends is the second occurrence (+02), like PostgreSQL", () => {
    expect(cairoInstant("2027-10-28", "23:30").toISOString()).toBe("2027-10-28T21:30:00.000Z");
    expect(cairoInstant("2027-10-28", "22:59").toISOString()).toBe("2027-10-28T19:59:00.000Z");
  });

  it("T-09: an adjusted evening 19:00 → 02:00 is accepted and keeps its slot (BR-04)", () => {
    expect(times({ startTime: "19:00", endTime: "02:00" })).toMatchObject({
      startsAt: "2027-01-15T17:00:00.000Z",
      endsAt: "2027-01-16T00:00:00.000Z",
      minutes: 420,
    });
  });

  it("T-10: an end earlier than the start is on the next day (22:00 → 03:00 = 5 hours)", () => {
    expect(times({ startTime: "22:00", endTime: "03:00" })).toMatchObject({ minutes: 300 });
  });

  it("T-11: end = start is refused (D-100)", () => {
    expect(violation({ startTime: "20:00", endTime: "20:00" })).toBe("sameStartEnd");
  });

  it("T-12: a start of 00:30 is on the event date itself, not the next day (BR-04)", () => {
    expect(times({ startTime: "00:30", endTime: "04:00" }).startsAt).toBe("2027-01-14T22:30:00.000Z");
  });

  it("T-13: 23.5 hours on the clock but 24.5 real hours on 2027-10-28 is refused (BR-04, D-37)", () => {
    expect(violation({ eventDate: "2027-10-28", startTime: "02:00", endTime: "01:30" })).toBe("tooLong");
  });

  it("T-14: exactly 24 real hours is accepted (the limit)", () => {
    expect(times({ eventDate: "2027-10-28", startTime: "02:00", endTime: "01:00" }).minutes).toBe(1440);
  });

  it("T-15: with no buffer, blocked_until = ends_at (BR-10)", () => {
    const t = times({ bufferMinutes: 0 });
    expect(t.blockedUntil).toBe(t.endsAt);
  });

  it("a start inside the skipped hour after its end is refused", () => {
    // 00:30 becomes 01:30 (+03) on 2027-04-30, after an end typed as 01:15.
    expect(violation({ eventDate: "2027-04-30", startTime: "00:30", endTime: "01:15" })).toBe("endBeforeStart");
  });

  it("D-111: adjusted times that run into the other slot are flagged", () => {
    const at = (slotKind: "day" | "evening" | "full_day", startTime: string, endTime: string) => {
      const r = bookingTimes({
        eventDate: "2027-01-15",
        slotKind,
        slots: SLOTS,
        bufferMinutes: 60,
        startTime,
        endTime,
      });
      if (!r.ok) throw new Error(r.violation);
      return intrudesOtherSlot(r.times, slotKind, SLOTS, "2027-01-15");
    };
    expect(at("day", "13:00", "18:00")).toBe(false);
    expect(at("day", "13:00", "20:00")).toBe(false);
    expect(at("day", "13:00", "23:00")).toBe(true);
    expect(at("evening", "18:00", "01:00")).toBe(false);
    expect(at("evening", "17:00", "01:00")).toBe(true);
    expect(at("full_day", "10:00", "02:00")).toBe(false);
  });
});

describe("new booking dates (BR-27, D-109)", () => {
  const now = new Date("2026-10-18T10:00:00Z"); // 13:00 in Cairo
  const check = (date: string, time = "20:00") => bookingDateViolation(date, cairoInstant(date, time), now);

  it("from today to three years ahead, starting after now", () => {
    expect(check("2026-10-17")).toBe("datePassed");
    expect(check("2026-10-18")).toBeNull();
    expect(check("2026-10-18", "12:00")).toBe("startPassed");
    expect(check("2029-10-18")).toBeNull();
    expect(check("2029-10-19")).toBe("dateTooFar");
  });
});

describe("display status (BR-13, BR-24, D-104, ADR-007)", () => {
  const now = new Date("2027-01-10T12:00:00Z");
  const minute = 60_000;
  const tentative = (expiresInMs: number): StatusFacts => ({
    status: "tentative",
    tentativeExpiresAt: new Date(now.getTime() + expiresInMs),
    endsAt: new Date("2027-01-15T23:00:00Z"),
  });
  const confirmed = (endsInMs: number): StatusFacts => ({
    status: "confirmed",
    tentativeExpiresAt: null,
    endsAt: new Date(now.getTime() + endsInMs),
  });

  it("S-01: tentative a minute before it expires", () => {
    expect(displayStatus(tentative(minute), now, false)).toBe("tentative");
    expect(isLiveTentative(tentative(minute), now)).toBe(true);
  });
  it("S-02: expired exactly at tentative_expires_at", () => {
    expect(displayStatus(tentative(0), now, false)).toBe("expired");
    expect(isLiveTentative(tentative(0), now)).toBe(false);
  });
  it("S-03: a tentative booking overlapping a confirmed one is conflicting (BR-13)", () => {
    expect(displayStatus(tentative(minute), now, true)).toBe("conflicting");
  });
  it("S-04: expiry comes before conflict (D-104)", () => {
    expect(displayStatus(tentative(-minute), now, true)).toBe("expired");
  });
  it("S-05: confirmed a minute before its end", () => {
    expect(displayStatus(confirmed(minute), now, false)).toBe("confirmed");
  });
  it("S-06: completed exactly at ends_at (BR-24)", () => {
    expect(displayStatus(confirmed(0), now, false)).toBe("completed");
  });
  it("S-07: cancelled, whatever else holds", () => {
    expect(displayStatus({ ...tentative(-minute), status: "cancelled" }, now, true)).toBe("cancelled");
  });
});

describe("overlap mirror of bookings_no_overlap (BR-10, BR-11)", () => {
  // E of §9.1: 20:00 → 01:00 (+1), blocked until 02:00 (+1), Cairo +02:00.
  const at = (date: string, time: string) => cairoInstant(date, time);
  const E: BlockedRange = { startsAt: at("2027-01-15", "20:00"), blockedUntil: at("2027-01-16", "02:00") };
  const range = (start: [string, string], end: [string, string], buffer = 60): BlockedRange => ({
    startsAt: at(...start),
    blockedUntil: new Date(at(...end).getTime() + buffer * 60_000),
  });

  it.each([
    ["O-01 same slot", range(["2027-01-15", "20:00"], ["2027-01-16", "01:00"]), true],
    ["O-02 contains E", range(["2027-01-15", "13:00"], ["2027-01-16", "01:00"]), true],
    ["O-03 inside E", range(["2027-01-15", "21:00"], ["2027-01-15", "23:00"]), true],
    ["O-04 partial start", range(["2027-01-15", "17:00"], ["2027-01-15", "20:30"]), true],
    ["O-05 partial end", range(["2027-01-15", "23:00"], ["2027-01-16", "03:00"]), true],
    ["O-06 starts at E's blocked_until", range(["2027-01-16", "02:00"], ["2027-01-16", "06:00"]), false],
    ["O-07 inside E's buffer", range(["2027-01-16", "01:30"], ["2027-01-16", "06:00"]), true],
    ["O-08 its buffer ends at E's start", range(["2027-01-15", "13:00"], ["2027-01-15", "19:00"]), false],
    ["O-09 its buffer runs into E", range(["2027-01-15", "13:00"], ["2027-01-15", "19:30"]), true],
    ["O-10 the default day slot", range(["2027-01-15", "13:00"], ["2027-01-15", "18:00"]), false],
    ["O-21 one minute into the buffer", range(["2027-01-16", "01:59"], ["2027-01-16", "06:00"]), true],
  ])("%s → overlaps: %s", (_name, candidate, expected) => {
    expect(rangesOverlap(candidate, E)).toBe(expected);
    expect(rangesOverlap(E, candidate)).toBe(expected);
  });
});

describe("booking numbers (BR-26, D-42)", () => {
  it("YYYY-NNNN with at least four digits", () => {
    expect(bookingNumber(2027, 1)).toBe("2027-0001");
    expect(bookingNumber(2027, 9999)).toBe("2027-9999");
    expect(bookingNumber(2027, 10000)).toBe("2027-10000");
  });
  it("the year is Cairo's: 22:30Z on 31 December is already the new year", () => {
    expect(cairoYear(new Date("2026-12-31T22:30:00Z"))).toBe(2027);
    expect(cairoYear(new Date("2026-12-31T21:30:00Z"))).toBe(2026);
  });
});
