import { describe, expect, it } from "vitest";
import {
  refundsNothing,
  tierFor,
  tierRanges,
  tierViolation,
  tiersConfigured,
  type CancellationTier,
} from "@/domain/cancellation-tiers";
import {
  applyBps,
  bpsToInput,
  formatBps,
  formatPiasters,
  MAX_PIASTERS,
  parsePercent,
  parsePounds,
  piastersToInput,
} from "@/domain/money";
import { findOverlap, rangesOverlap, seasonForDate, seasonForInstant } from "@/domain/seasons";
import { bookingReadinessGaps, setupChecklist, type SetupFacts } from "@/domain/setup-checklist";
import { fullDay, maxBufferFor, slotViolations, toHhMm, type SpaceSlotTimes } from "@/domain/slots";
import { cairoDate, isIsoDate } from "@/lib/time";

describe("money (BR-36)", () => {
  it.each([
    ["1500", 150000],
    ["1500.5", 150050],
    ["1500.50", 150050],
    ["1,500.05", 150005],
    ["١٥٠٠٫٥", 150050],
    [" 0 ", 0],
    ["0.01", 1],
    // Where × 100 on a float goes wrong: 19.99 × 100 = 1998.9999999999998, 0.29 × 100 = 28.999999999999996.
    ["1234.56", 123456],
    ["0.1", 10],
    ["19.99", 1999],
    ["0.29", 29],
    ["1.15", 115],
  ])("parses %s pounds as %i piasters, without floating point", (input, piasters) => {
    expect(parsePounds(input)).toBe(piasters);
  });

  it("the float route really is wrong for these amounts — which is why the text is read digit by digit", () => {
    expect(19.99 * 100).not.toBe(1999);
    expect(0.29 * 100).not.toBe(29);
    expect(1.15 * 100).not.toBe(115);
    expect([parsePounds("19.99"), parsePounds("0.29"), parsePounds("1.15")]).toEqual([1999, 29, 115]);
  });

  it.each(["", "-5", "1.005", "1234.565", "abc", "1.2.3", "1e3", "١٠٠ج"])("rejects %s", (input) => {
    expect(parsePounds(input)).toBeNull();
  });

  it("caps amounts far below the unsafe-integer range", () => {
    expect(parsePounds(String(MAX_PIASTERS / 100))).toBe(MAX_PIASTERS);
    expect(parsePounds(String(MAX_PIASTERS / 100 + 1))).toBeNull();
  });

  it.each([
    ["12.5", 1250],
    ["12.5%", 1250],
    ["١٠٠٪", 10000],
    ["0", 0],
    ["33.33", 3333],
  ])("parses the percentage %s as %i basis points", (input, bps) => {
    expect(parsePercent(input)).toBe(bps);
  });

  it.each(["100.01", "101", "-1", "12.345"])("rejects the percentage %s", (input) => {
    expect(parsePercent(input)).toBeNull();
  });

  it("formats for display only, and back to input text", () => {
    expect(formatPiasters(150050)).toBe("١٬٥٠٠٫٥٠ ج.م");
    expect(formatPiasters(150000)).toBe("١٬٥٠٠ ج.م");
    expect(formatBps(1250)).toBe("١٢٫٥٪");
    expect(formatBps(10000)).toBe("١٠٠٪");
    expect(piastersToInput(150005)).toBe("1500.05");
    expect(bpsToInput(1250)).toBe("12.5");
    expect(bpsToInput(1225)).toBe("12.25");
    expect(parsePounds(piastersToInput(123456))).toBe(123456);
  });
});

describe("applyBps: rounding half up, once (BR-36, D-43, D-96)", () => {
  it.each([
    ["R-01", 1_234_567, 1250, 154_321], // 154,320.875
    ["R-02", 1, 5000, 1], // 0.5 → up
    ["R-03", 3, 5000, 2], // 1.5 → up
    ["R-04", 101, 5000, 51], // 50.5 → up
    ["R-05", 1_000_001, 2500, 250_000], // 250,000.25 → down
    ["R-06", 999, 3333, 333], // 332.9667 → up
    ["R-07", 6_000_000, 0, 0],
    ["R-07", 6_000_000, 10_000, 6_000_000],
    ["R-08", 100_000_000_000, 10_000, 100_000_000_000], // MAX_PIASTERS, no overflow
  ])("%s: %i × %i bps = %i piasters", (_case, amount, bps, expected) => {
    expect(applyBps(amount, bps)).toBe(expected);
  });

  it.each([
    [-1, 1000],
    [0.5, 1000],
    [MAX_PIASTERS + 1, 1000],
    [1000, -1],
    [1000, 10_001],
    [1000, 12.5],
  ])("R-09: rejects amount %d with %d bps", (amount, bps) => {
    expect(() => applyBps(amount, bps)).toThrow(RangeError);
  });
});

const slots = (day: [string, string], evening: [string, string]): SpaceSlotTimes => ({
  day: { start: day[0], end: day[1] },
  evening: { start: evening[0], end: evening[1] },
});

describe("space slots (BR-01, BR-02, D-69)", () => {
  it("BR-02: the day slot plus the buffer may end exactly at the evening start", () => {
    expect(slotViolations(slots(["12:00", "17:00"], ["18:00", "23:00"]), 60)).toEqual([]);
  });

  it("BR-02: one minute less than the buffer is rejected", () => {
    expect(slotViolations(slots(["12:00", "17:01"], ["18:00", "23:00"]), 60)).toEqual(["eveningTooEarly"]);
  });

  it("D-69: the evening slot may cross midnight, the day slot may not", () => {
    expect(slotViolations(slots(["12:00", "17:00"], ["19:00", "02:00"]), 60)).toEqual([]);
    expect(slotViolations(slots(["22:00", "02:00"], ["03:00", "05:00"]), 0)).toContain("dayCrossesMidnight");
  });

  it("D-69: the evening end plus the buffer must not pass the next day's day start", () => {
    // Evening ends 03:00, the next day slot starts 01:00.
    expect(slotViolations(slots(["01:00", "06:00"], ["19:00", "03:00"]), 0)).toEqual(["eveningIntoNextDay"]);
    // Ends 10:00 + 60 minutes = the next day start at 11:00: accepted.
    expect(slotViolations(slots(["11:00", "16:00"], ["17:00", "10:00"]), 60)).toEqual([]);
    expect(slotViolations(slots(["11:00", "16:00"], ["17:00", "10:01"]), 60)).toEqual(["eveningIntoNextDay"]);
  });

  it("rejects zero-length slots", () => {
    expect(slotViolations(slots(["12:00", "12:00"], ["18:00", "23:00"]), 0)).toContain("zeroLength");
    expect(slotViolations(slots(["12:00", "17:00"], ["18:00", "18:00:00"]), 0)).toContain("zeroLength");
  });

  it("BR-01: the full day runs from the day start to the evening end, at most 24 hours", () => {
    expect(fullDay(slots(["12:00", "17:00"], ["19:00", "02:00"]))).toEqual({
      start: "12:00",
      end: "02:00",
      minutes: 840,
    });
    const longest = slots(["11:00", "16:00"], ["16:00", "11:00"]);
    expect(slotViolations(longest, 0)).toEqual([]);
    expect(fullDay(longest).minutes).toBe(24 * 60);
  });

  it("D-51: the largest allowed buffer is the smaller of the two gaps", () => {
    expect(maxBufferFor(slots(["12:00", "17:00"], ["19:00", "02:00"]))).toBe(120); // 17→19, then 02→12 = 600
    expect(maxBufferFor(slots(["12:00", "17:00"], ["17:30", "11:45"]))).toBe(15); // 11:45 → next day 12:00
    expect(maxBufferFor(slots(["22:00", "02:00"], ["03:00", "05:00"]))).toBeNull();
  });

  it("reads database times with seconds", () => {
    expect(toHhMm("19:30:00")).toBe("19:30");
  });
});

describe("seasons (BR-31)", () => {
  const summer = { id: "s", name: "الصيف", startDate: "2026-07-01", endDate: "2026-08-31" };

  it("BR-31: a date inside, on each edge, and outside the season", () => {
    expect(seasonForDate([summer], "2026-07-01")).toBe(summer);
    expect(seasonForDate([summer], "2026-08-31")).toBe(summer);
    expect(seasonForDate([summer], "2026-08-15")).toBe(summer);
    expect(seasonForDate([summer], "2026-06-30")).toBeUndefined();
    expect(seasonForDate([summer], "2026-09-01")).toBeUndefined();
    expect(seasonForDate([{ ...summer, isActive: false }], "2026-08-15")).toBeUndefined();
  });

  it("BR-31: decided by the Cairo date of the start, not UTC (summer time, UTC+3)", () => {
    // 2026-06-30 21:30 UTC = 2026-07-01 00:30 in Cairo.
    expect(cairoDate(new Date("2026-06-30T21:30:00Z"))).toBe("2026-07-01");
    expect(seasonForInstant([summer], new Date("2026-06-30T21:30:00Z"))).toBe(summer);
    // 2026-08-31 21:30 UTC = 2026-09-01 00:30 in Cairo: already outside.
    expect(seasonForInstant([summer], new Date("2026-08-31T21:30:00Z"))).toBeUndefined();
  });

  it("BR-31: Cairo winter time is UTC+2", () => {
    expect(cairoDate(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
    expect(cairoDate(new Date("2026-12-31T21:30:00Z"))).toBe("2026-12-31");
  });

  it("BR-31: adjacent seasons do not overlap; a shared day does", () => {
    const autumn = { id: "a", startDate: "2026-09-01", endDate: "2026-10-31" };
    expect(rangesOverlap(summer, autumn)).toBe(false);
    expect(rangesOverlap(summer, { ...autumn, startDate: "2026-08-31" })).toBe(true);
    expect(findOverlap({ startDate: "2026-08-31", endDate: "2026-09-10" }, [summer, autumn])).toBe(summer);
    // Editing a season does not conflict with itself; inactive seasons are ignored.
    expect(findOverlap({ ...summer, endDate: "2026-08-20" }, [summer])).toBeUndefined();
    expect(
      findOverlap({ startDate: "2026-07-05", endDate: "2026-07-06" }, [{ ...summer, isActive: false }]),
    ).toBeUndefined();
  });

  it("validates calendar dates", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-01-01")).toBe(false);
  });
});

describe("cancellation tiers (BR-71, BR-77, D-67)", () => {
  const policy: CancellationTier[] = [
    { minDaysBefore: 90, refundBps: 10000 },
    { minDaysBefore: 0, refundBps: 0 },
    { minDaysBefore: 30, refundBps: 5000 },
  ];

  it("D-67: configured means at least one tier, and a single 0% tier is valid", () => {
    expect(tiersConfigured([])).toBe(false);
    expect(tierViolation([])).toBe("tiersRequired");
    expect(tierViolation([{ minDaysBefore: 0, refundBps: 0 }])).toBeNull();
  });

  it("BR-77: unique days, ranges, and a refund that never decreases with more days", () => {
    expect(tierViolation(policy)).toBeNull();
    expect(tierViolation([...policy, { minDaysBefore: 30, refundBps: 6000 }])).toBe("tierDaysDuplicate");
    expect(tierViolation([{ minDaysBefore: 731, refundBps: 0 }])).toBe("tierOutOfRange");
    expect(tierViolation([{ minDaysBefore: 10, refundBps: 10001 }])).toBe("tierOutOfRange");
    expect(tierViolation([{ minDaysBefore: 1.5, refundBps: 0 }])).toBe("tierOutOfRange");
    expect(
      tierViolation([
        { minDaysBefore: 60, refundBps: 2500 },
        { minDaysBefore: 30, refundBps: 5000 },
      ]),
    ).toBe("tierOrder");
    // Equal refunds for more days are allowed.
    expect(
      tierViolation([
        { minDaysBefore: 60, refundBps: 5000 },
        { minDaysBefore: 30, refundBps: 5000 },
      ]),
    ).toBeNull();
  });

  it("D-74: a policy where every tier is 0% refunds nothing and needs explicit confirmation", () => {
    expect(refundsNothing([{ minDaysBefore: 0, refundBps: 0 }])).toBe(true);
    expect(
      refundsNothing([
        { minDaysBefore: 0, refundBps: 0 },
        { minDaysBefore: 60, refundBps: 0 },
      ]),
    ).toBe(true);
    expect(refundsNothing(policy)).toBe(false);
    expect(refundsNothing([])).toBe(false);
  });

  it("BR-71: the tier with the largest day count not above the days remaining; none → no tier", () => {
    expect(tierFor(policy, 120)?.refundBps).toBe(10000);
    expect(tierFor(policy, 90)?.refundBps).toBe(10000);
    expect(tierFor(policy, 89)?.refundBps).toBe(5000);
    expect(tierFor(policy, 30)?.refundBps).toBe(5000);
    expect(tierFor(policy, 0)?.refundBps).toBe(0);
    expect(tierFor([{ minDaysBefore: 30, refundBps: 5000 }], 10)).toBeNull();
  });
});

describe("guided setup checklist (UF-02, D-71)", () => {
  const empty: SetupFacts = {
    venue: { name: "قاعة", phone: null, address: null },
    activeSpaces: 0,
    activeSeasons: 0,
    activeEventTypes: 0,
    activePaymentMethods: 0,
    cancellationTiers: 0,
    activeStaff: 0,
    activeServices: 0,
    pricedPackages: 0,
  };
  const status = (facts: SetupFacts) => Object.fromEntries(setupChecklist(facts).steps.map((s) => [s.key, s.status]));

  it("a new venue: only timing is done; seasons and staff are optional; services and packages are required", () => {
    expect(status(empty)).toEqual({
      venue: "missing",
      spaces: "missing",
      timing: "done",
      seasons: "optional",
      eventTypes: "missing",
      paymentMethods: "missing",
      services: "missing",
      packages: "missing",
      policies: "missing",
      staff: "optional",
    });
    expect(setupChecklist(empty).steps.map((s) => s.key)).toEqual([
      "venue",
      "spaces",
      "timing",
      "seasons",
      "eventTypes",
      "paymentMethods",
      "services",
      "packages",
      "policies",
      "staff",
    ]);
  });

  it("each step turns done from its own fact", () => {
    const full: SetupFacts = {
      venue: { name: "قاعة", phone: "0221234567", address: "القاهرة" },
      activeSpaces: 1,
      activeSeasons: 1,
      activeEventTypes: 1,
      activePaymentMethods: 1,
      cancellationTiers: 1,
      activeStaff: 1,
      activeServices: 1,
      pricedPackages: 1,
    };
    expect(Object.values(status(full)).every((s) => s === "done")).toBe(true);
    expect(setupChecklist(full).complete).toBe(true);
    expect(setupChecklist({ ...full, activeSeasons: 0, activeStaff: 0 }).complete).toBe(true);
    expect(status({ ...full, venue: { ...full.venue, address: "  " } }).venue).toBe("missing");
    expect(setupChecklist({ ...full, cancellationTiers: 0 }).complete).toBe(false);
  });

  it("is not complete without an active service and a priced package (D-71, D-77)", () => {
    const allButCatalog: SetupFacts = {
      ...empty,
      venue: { name: "قاعة", phone: "1", address: "2" },
      activeSpaces: 1,
      activeEventTypes: 1,
      activePaymentMethods: 1,
      cancellationTiers: 1,
    };
    expect(setupChecklist(allButCatalog).complete).toBe(false);
    expect(setupChecklist({ ...allButCatalog, activeServices: 1 }).complete).toBe(false);
    expect(setupChecklist({ ...allButCatalog, pricedPackages: 1 }).complete).toBe(false);
    expect(setupChecklist({ ...allButCatalog, activeServices: 1, pricedPackages: 1 }).complete).toBe(true);
  });

  it("BR-21 (5), UF-02 step 3: an active space, a priced package and the tiers are required to confirm", () => {
    expect(bookingReadinessGaps({ activeSpaces: 0, pricedPackages: 0, cancellationTiers: 0 })).toEqual([
      "activeSpace",
      "pricedPackage",
      "cancellationTiers",
    ]);
    expect(bookingReadinessGaps({ activeSpaces: 2, pricedPackages: 1, cancellationTiers: 1 })).toEqual([]);
  });
});

describe("cancellation tiers as the contract states them (P-02, D-68)", () => {
  it("90 → 75%, 30 → 50%, 0 → 0%: 90+, 30–89, 0–29", () => {
    expect(
      tierRanges([
        { minDaysBefore: 30, refundBps: 5000 },
        { minDaysBefore: 0, refundBps: 0 },
        { minDaysBefore: 90, refundBps: 7500 },
      ]),
    ).toEqual([
      { fromDays: 90, toDays: null, refundBps: 7500 },
      { fromDays: 30, toDays: 89, refundBps: 5000 },
      { fromDays: 0, toDays: 29, refundBps: 0 },
    ]);
  });

  it("without a 0-day tier the days below the shortest refund nothing; one 0-day tier covers all", () => {
    expect(tierRanges([{ minDaysBefore: 14, refundBps: 10000 }])).toEqual([
      { fromDays: 14, toDays: null, refundBps: 10000 },
      { fromDays: 0, toDays: 13, refundBps: 0 },
    ]);
    expect(tierRanges([{ minDaysBefore: 0, refundBps: 2500 }])).toEqual([
      { fromDays: 0, toDays: null, refundBps: 2500 },
    ]);
  });
});
