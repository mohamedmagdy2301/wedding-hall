import { describe, expect, it } from "vitest";
import { depositViolation, minimumDeposit, type DepositPolicy } from "@/domain/deposit";
import { installmentStatuses, rebalanceSchedule, scheduleViolation, type ScheduleLine } from "@/domain/installments";
import { parsePounds } from "@/domain/money";
import {
  activeDeposit,
  exceedsTotal,
  formatReceiptNo,
  ledger,
  paidAsOfReceipt,
  type LedgerEntry,
  type ReceiptEntry,
} from "@/domain/payments";
import { cairoDate, cairoInstant } from "@/lib/time";

/**
 * PHASE6_PLAN §6.2–§6.5, the pure part: minimum deposit (MD-01..MD-08), the ledger
 * (L-01..L-05), the schedule (I-01..I-11), coverage and overdue (OD-01..OD-08) and the
 * receipt as of its issuance (RC-01..RC-04). Amounts are written in pounds and compared in
 * piasters.
 */

const p = (pounds: string) => {
  const piasters = parsePounds(pounds);
  if (piasters === null) throw new Error(`bad amount ${pounds}`);
  return piasters;
};

const TOTAL = p("60,000");
const NONE: DepositPolicy = { minDepositType: "none", minDepositValue: 0 };
const fixed = (pounds: string): DepositPolicy => ({ minDepositType: "fixed", minDepositValue: p(pounds) });
const percent = (bps: number): DepositPolicy => ({ minDepositType: "percent", minDepositValue: bps });

describe("minimum deposit (BR-21 item 1, BR-63, D-119)", () => {
  it("MD-01: without a minimum any positive deposit is enough; zero is not", () => {
    expect(minimumDeposit(TOTAL, NONE)).toBe(0);
    expect(depositViolation(TOTAL, NONE, p("0.01"))).toBeNull();
    expect(depositViolation(TOTAL, NONE, 0)).toBe("depositRequired");
  });

  it("MD-02: fixed 5,000 — 4,999.99 is refused, 5,000 accepted", () => {
    expect(depositViolation(TOTAL, fixed("5,000"), p("4,999.99"))).toBe("depositBelowMinimum");
    expect(depositViolation(TOTAL, fixed("5,000"), p("5,000"))).toBeNull();
  });

  it("MD-03: a fixed 10,000 on a total of 8,000 asks for the whole total", () => {
    expect(minimumDeposit(p("8,000"), fixed("10,000"))).toBe(p("8,000"));
    expect(depositViolation(p("8,000"), fixed("10,000"), p("8,000"))).toBeNull();
  });

  it("MD-04: 25% of 60,000 is 15,000", () => {
    expect(minimumDeposit(TOTAL, percent(2500))).toBe(p("15,000"));
  });

  it("MD-05: 50% of 60,000.01 is 3,000,000.5 piasters → 30,000.01 (half up, D-96)", () => {
    expect(minimumDeposit(p("60,000.01"), percent(5000))).toBe(p("30,000.01"));
  });

  it("MD-06: 100% is the total", () => {
    expect(minimumDeposit(TOTAL, percent(10_000))).toBe(TOTAL);
  });

  it("MD-07: BR-63 — 60,000.01 is refused under any policy, 60,000 is accepted (paid in full)", () => {
    for (const policy of [NONE, fixed("5,000"), percent(2500)]) {
      expect(depositViolation(TOTAL, policy, p("60,000.01"))).toBe("depositExceedsTotal");
      expect(depositViolation(TOTAL, policy, TOTAL)).toBeNull();
    }
  });

  it("MD-08: the minimum is taken on the re-priced total — 25% of 64,000 refuses 15,000", () => {
    expect(minimumDeposit(p("64,000"), percent(2500))).toBe(p("16,000"));
    expect(depositViolation(p("64,000"), percent(2500), p("15,000"))).toBe("depositBelowMinimum");
  });
});

const entry = (kind: LedgerEntry["kind"], pounds: string, voided = false): LedgerEntry => ({
  kind,
  amount: p(pounds),
  voided,
});

describe("the ledger (BR-62, BR-63)", () => {
  it("L-01: deposit 15,000 + installment 20,000 → paid 35,000, remaining 25,000", () => {
    expect(ledger(TOTAL, [entry("deposit", "15,000"), entry("installment", "20,000")])).toEqual({
      total: TOTAL,
      paid: p("35,000"),
      remaining: p("25,000"),
    });
  });

  it("L-02: a voided payment of 5,000 is left out", () => {
    const rows = [entry("deposit", "15,000"), entry("installment", "20,000"), entry("payment", "5,000", true)];
    expect(ledger(TOTAL, rows).paid).toBe(p("35,000"));
  });

  it("L-03: a refund of 2,000 takes away; once voided it no longer does", () => {
    const base = [entry("deposit", "15,000"), entry("installment", "20,000")];
    expect(ledger(TOTAL, [...base, entry("refund", "2,000")]).paid).toBe(p("33,000"));
    expect(ledger(TOTAL, [...base, entry("refund", "2,000", true)]).paid).toBe(p("35,000"));
  });

  it("L-04: with 25,000 remaining, 25,000.01 is refused and 25,000 accepted", () => {
    expect(exceedsTotal(TOTAL, p("35,000"), p("25,000.01"))).toBe(true);
    expect(exceedsTotal(TOTAL, p("35,000"), p("25,000"))).toBe(false);
  });

  it("L-05: voiding a payment of 20,000 makes room for a new one of 20,000", () => {
    const rows = [entry("deposit", "15,000"), entry("installment", "20,000", true), entry("payment", "25,000")];
    expect(exceedsTotal(TOTAL, ledger(TOTAL, rows).paid, p("20,000"))).toBe(false);
  });

  it("BR-60: the active deposit is the one not voided", () => {
    expect(activeDeposit([entry("deposit", "15,000", true), entry("payment", "1,000")])).toBeUndefined();
    expect(activeDeposit([entry("deposit", "15,000", true), entry("deposit", "10,000")])?.amount).toBe(p("10,000"));
  });

  it("BR-61: receipt numbers have six digits at least", () => {
    expect(formatReceiptNo(1)).toBe("000001");
    expect(formatReceiptNo(999_999)).toBe("999999");
    expect(formatReceiptNo(1_000_000)).toBe("1000000");
  });
});

// §6.4: a party on 2027-03-15 at 20:00–01:00, total 60,000, deposit 15,000.
const EVENT = "2027-03-15";
const I01: ScheduleLine[] = [
  { dueDate: "2027-01-15", amount: p("20,000") },
  { dueDate: "2027-03-14", amount: p("25,000") },
];
const violationOf = (lines: ScheduleLine[], deposit = p("15,000")) =>
  scheduleViolation({ total: TOTAL, deposit, eventDate: EVENT, lines });

describe("the installment schedule (BR-65, D-33)", () => {
  it("I-01: 20,000 on 2027-01-15 + 25,000 on 2027-03-14 is accepted", () => {
    expect(violationOf(I01)).toBeNull();
  });

  it("I-02: the last one on the party day is refused (D-33)", () => {
    expect(violationOf([I01[0], { ...I01[1], dueDate: EVENT }])).toEqual({
      violation: "installmentAfterEve",
      index: 1,
    });
  });

  it("I-03: a sum of 59,999.99 is refused with the 0.01 missing", () => {
    expect(violationOf([I01[0], { ...I01[1], amount: p("24,999.99") }])).toEqual({
      violation: "scheduleSumMismatch",
      difference: p("0.01"),
    });
  });

  it("I-04: an installment of 0 or below is refused", () => {
    expect(violationOf([{ ...I01[0], amount: 0 }, I01[1]])).toEqual({
      violation: "installmentAmountInvalid",
      index: 0,
    });
    expect(violationOf([{ ...I01[0], amount: -100 }, I01[1]])).toEqual({
      violation: "installmentAmountInvalid",
      index: 0,
    });
  });

  it("I-05: a deposit of the whole total takes no installment; without any it is accepted", () => {
    expect(violationOf([{ dueDate: "2027-01-15", amount: 1 }], TOTAL)).toEqual({
      violation: "scheduleSumMismatch",
      difference: -1,
    });
    expect(violationOf([], TOTAL)).toBeNull();
  });

  it("I-06: an empty schedule means none", () => {
    expect(violationOf([])).toBeNull();
  });
});

describe("a replacement deposit rebalances the schedule (D-121, with the product owner's decisions)", () => {
  const amounts = (lines: ScheduleLine[] | null) => lines?.map((l) => l.amount) ?? null;
  const target = (deposit: string) => TOTAL - p(deposit);

  it("I-07: a deposit of 10,000 — the installments grow by 5,000 on the last one", () => {
    expect(amounts(rebalanceSchedule(I01, target("10,000")))).toEqual([p("20,000"), p("30,000")]);
  });

  it("I-08: 35,000 — the last one shrinks by 20,000 to 5,000", () => {
    expect(amounts(rebalanceSchedule(I01, target("35,000")))).toEqual([p("20,000"), p("5,000")]);
  });

  it("I-09: 45,000 — the last installment (25,000) is covered entirely and leaves; the first shrinks by 5,000 to one installment of 15,000", () => {
    expect(rebalanceSchedule(I01, target("45,000"))).toEqual([{ dueDate: "2027-01-15", amount: p("15,000") }]);
  });

  it("I-10: 60,000 — every installment is covered: the schedule empties (no installment of one piaster)", () => {
    expect(rebalanceSchedule(I01, target("60,000"))).toEqual([]);
    expect(rebalanceSchedule([], target("60,000"))).toEqual([]);
    expect(rebalanceSchedule(I01, -1)).toBeNull(); // above the total: BR-63 refuses it first
  });

  it("the order is by due date whatever order the lines come in, and dates are kept", () => {
    const result = rebalanceSchedule([I01[1], I01[0]], target("35,000"));
    expect(result).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-03-14", amount: p("5,000") },
    ]);
  });
});

describe("coverage and overdue installments (BR-66, D-55, D-120)", () => {
  const states = (today: string, paid: string) =>
    installmentStatuses(TOTAL, I01, p(paid), today).map(({ state, outstanding }) => ({ state, outstanding }));

  it("OD-01: on 2027-01-15 with 15,000 paid the first one is due today, not overdue", () => {
    expect(states("2027-01-15", "15,000")[0]).toEqual({ state: "dueToday", outstanding: p("20,000") });
  });

  it("OD-02: on 2027-01-16 with 15,000 paid the first one is 20,000 overdue", () => {
    expect(states("2027-01-16", "15,000")[0]).toEqual({ state: "overdue", outstanding: p("20,000") });
  });

  it("OD-03: with 30,000 paid it is 5,000 overdue", () => {
    expect(states("2027-01-16", "30,000")[0]).toEqual({ state: "overdue", outstanding: p("5,000") });
  });

  it("OD-04: with 35,000 paid it is covered", () => {
    expect(states("2027-01-16", "35,000")[0]).toEqual({ state: "paid", outstanding: 0 });
  });

  it("OD-05: on 2027-03-15 with 35,000 paid the second one is 25,000 overdue", () => {
    expect(states("2027-03-15", "35,000")).toEqual([
      { state: "paid", outstanding: 0 },
      { state: "overdue", outstanding: p("25,000") },
    ]);
  });

  it("OD-06: paying 50,000 early covers the first and 15,000 of the second", () => {
    const [first, second] = installmentStatuses(TOTAL, I01, p("50,000"), "2027-01-10");
    expect(first).toMatchObject({ state: "paid", covered: p("20,000") });
    expect(second).toMatchObject({ state: "upcoming", covered: p("15,000"), outstanding: p("10,000") });
  });

  it("OD-07: the deposit voided and 20,000 paid — the first is 15,000 overdue", () => {
    expect(states("2027-01-16", "20,000")[0]).toEqual({ state: "overdue", outstanding: p("15,000") });
  });

  it("OD-08: the day is Cairo's — 23:30 on the 15th is not overdue, 00:00:01 on the 16th is", () => {
    const late = new Date(cairoInstant("2027-01-15", "23:30").getTime());
    const after = new Date(cairoInstant("2027-01-16", "00:00").getTime() + 1000);
    expect(cairoDate(late)).toBe("2027-01-15");
    expect(states(cairoDate(late), "15,000")[0].state).toBe("dueToday");
    expect(states(cairoDate(after), "15,000")[0].state).toBe("overdue");
  });
});

describe("paid as of a receipt's issuance (D-122)", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute));
  const rows: ReceiptEntry[] = [
    { receiptNo: "000001", kind: "deposit", amount: p("15,000"), createdAt: at(0), voidedAt: null },
    { receiptNo: "000002", kind: "installment", amount: p("20,000"), createdAt: at(10), voidedAt: null },
  ];

  it("RC-01: reprinting 000001 after 000002 still shows 15,000 paid", () => {
    expect(paidAsOfReceipt(rows, "000001")).toBe(p("15,000"));
    expect(paidAsOfReceipt(rows, "000002")).toBe(p("35,000"));
  });

  it("RC-02 / RC-03: voiding 000002 later changes neither receipt", () => {
    const voided = [rows[0], { ...rows[1], voidedAt: at(30) }];
    expect(paidAsOfReceipt(voided, "000001")).toBe(p("15,000"));
    expect(paidAsOfReceipt(voided, "000002")).toBe(p("35,000"));
  });

  it("a payment voided before a receipt was issued is not on it", () => {
    const voided = [rows[0], { ...rows[1], voidedAt: at(20) }];
    const third: ReceiptEntry = {
      receiptNo: "000003",
      kind: "payment",
      amount: p("5,000"),
      createdAt: at(25),
      voidedAt: null,
    };
    expect(paidAsOfReceipt([...voided, third], "000003")).toBe(p("20,000"));
  });

  it("RC-04: a backdated payment recorded after 000002 counts by its number, not its date", () => {
    const backdated: ReceiptEntry = {
      receiptNo: "000003",
      kind: "payment",
      amount: p("5,000"),
      createdAt: at(40),
      voidedAt: null,
    };
    expect(paidAsOfReceipt([...rows, backdated], "000002")).toBe(p("35,000"));
    expect(paidAsOfReceipt([...rows, backdated], "000003")).toBe(p("40,000"));
  });
});
