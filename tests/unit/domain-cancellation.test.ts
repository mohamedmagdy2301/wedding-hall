import { describe, expect, it } from "vitest";
import { cancellationQuote, daysRemaining, lateInstallments, postponedSchedule } from "@/domain/cancellation";
import type { CancellationTier } from "@/domain/cancellation-tiers";
import { parsePounds } from "@/domain/money";
import type { LedgerEntry } from "@/domain/payments";
import { cairoDate } from "@/lib/time";

/**
 * PHASE8_PLAN §4, the pure part: the refund a cancellation suggests (CN-01..CN-07, CN-10,
 * CN-11) and the schedule a postponement suggests (BR-84, PP-06). Amounts are written in
 * pounds and compared in piasters.
 */

const p = (pounds: string) => {
  const piasters = parsePounds(pounds);
  if (piasters === null) throw new Error(`bad amount ${pounds}`);
  return piasters;
};

const EVENT = "2027-03-20";
// The booking's snapshot (D-68): 90 days → 75%, 30 → 50%, 0 → 0%.
const TIERS: CancellationTier[] = [
  { minDaysBefore: 0, refundBps: 0 },
  { minDaysBefore: 90, refundBps: 7500 },
  { minDaysBefore: 30, refundBps: 5000 },
];
const deposit = (amount: string, voided = false): LedgerEntry => ({ kind: "deposit", amount: p(amount), voided });
const paid = (amount: string, kind: LedgerEntry["kind"] = "installment"): LedgerEntry => ({
  kind,
  amount: p(amount),
  voided: false,
});

const quote = (
  cancelDate: string,
  ledger: LedgerEntry[] = [deposit("15,000")],
  basis: "deposit" | "total_paid" = "deposit",
) => cancellationQuote({ tiers: TIERS, basis, ledger, eventDate: EVENT, cancelDate });

describe("BR-70 days remaining", () => {
  it("counts whole Cairo calendar days, negative once the party's day passed", () => {
    expect(daysRemaining(EVENT, "2026-12-20")).toBe(90);
    expect(daysRemaining(EVENT, EVENT)).toBe(0);
    expect(daysRemaining(EVENT, "2027-03-21")).toBe(-1);
    // Across the end of February and a leap year.
    expect(daysRemaining("2028-03-01", "2028-02-28")).toBe(2);
  });
});

describe("BR-71, BR-72 the suggested refund", () => {
  it("CN-01: 90 days → the 90-day tier, 75% of the deposit", () => {
    const q = quote("2026-12-20");
    expect(q.daysRemaining).toBe(90);
    expect(q.tier).toEqual({ minDaysBefore: 90, refundBps: 7500 });
    expect(q.suggested).toBe(p("11,250"));
  });

  it("CN-02, CN-03: the boundaries of each tier", () => {
    expect(quote("2026-12-21").suggested).toBe(p("7,500"));
    expect(quote("2027-02-18").suggested).toBe(p("7,500"));
    expect(quote("2027-02-19").suggested).toBe(0);
    expect(quote(EVENT).refundBps).toBe(0);
  });

  it("CN-04: basis total_paid = the net paid", () => {
    const q = quote("2026-12-20", [deposit("15,000"), paid("20,000")], "total_paid");
    expect(q.basis).toBe(p("35,000"));
    expect(q.suggested).toBe(p("26,250"));
  });

  it("CN-05: a voided deposit is left out, its replacement counts", () => {
    const q = quote("2026-12-20", [deposit("15,000", true), deposit("10,000")]);
    expect(q.basis).toBe(p("10,000"));
    expect(q.suggested).toBe(p("7,500"));
  });

  it("BR-72: earlier refunds lower the total_paid basis", () => {
    const q = quote("2026-12-20", [deposit("15,000"), paid("20,000"), paid("5,000", "refund")], "total_paid");
    expect(q.basis).toBe(p("30,000"));
    expect(q.netPaid).toBe(p("30,000"));
  });

  it("CN-06: no matching tier → 0%", () => {
    const q = cancellationQuote({
      tiers: [{ minDaysBefore: 30, refundBps: 5000 }],
      basis: "deposit",
      ledger: [deposit("15,000")],
      eventDate: EVENT,
      cancelDate: "2027-03-10",
    });
    expect(q.tier).toBeNull();
    expect(q.suggested).toBe(0);
  });

  it("CN-07: rounded once, half up (BR-36)", () => {
    const q = cancellationQuote({
      tiers: [{ minDaysBefore: 0, refundBps: 5000 }],
      basis: "deposit",
      ledger: [deposit("333.33")],
      eventDate: EVENT,
      cancelDate: "2027-03-01",
    });
    expect(q.suggested).toBe(p("166.67"));
  });

  it("CN-10: never above the net paid", () => {
    // Deposit 15,000, then 5,000 of it refunded as a customer's credit: net paid 10,000.
    const q = quote("2026-12-20", [deposit("15,000"), paid("5,000", "refund")]);
    expect(q.basis).toBe(p("15,000"));
    expect(q.suggested).toBe(p("10,000"));
  });

  it("CN-11: the cancellation date is the Cairo date, not UTC's", () => {
    const at = new Date("2026-12-20T22:30:00Z"); // 00:30 on 21 December in Cairo
    expect(quote(cairoDate(at)).suggested).toBe(p("7,500"));
  });
});

describe("BR-84 the schedule a postponement suggests", () => {
  const schedule = [
    { dueDate: "2027-01-15", amount: p("20,000") },
    { dueDate: "2027-03-14", amount: p("23,000") },
  ];

  it("PP-06: installments after the new eve become one on the eve", () => {
    expect(lateInstallments(schedule, "2027-02-10")).toEqual([schedule[1]]);
    expect(postponedSchedule(schedule, "2027-02-10", p("43,000"))).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-02-09", amount: p("23,000") },
    ]);
  });

  it("a later date keeps the schedule and moves the difference to the last installment (D-121)", () => {
    expect(lateInstallments(schedule, "2027-07-15")).toEqual([]);
    expect(postponedSchedule(schedule, "2027-07-15", p("53,000"))).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-03-14", amount: p("33,000") },
    ]);
  });

  it("a lower total comes off the newest first", () => {
    expect(postponedSchedule(schedule, "2027-02-10", p("33,000"))).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-02-09", amount: p("13,000") },
    ]);
  });

  it("a late installment folds into one already on the eve", () => {
    const lines = [...schedule, { dueDate: "2027-02-09", amount: p("1,000") }];
    expect(postponedSchedule(lines, "2027-02-10", p("44,000"))).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-02-09", amount: p("24,000") },
    ]);
  });

  it("every installment late: one installment on the eve", () => {
    expect(postponedSchedule(schedule, "2027-01-10", p("43,000"))).toEqual([
      { dueDate: "2027-01-09", amount: p("43,000") },
    ]);
  });
});
