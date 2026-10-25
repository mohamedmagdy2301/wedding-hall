import { describe, expect, it } from "vitest";
import { profit, sumExpenses } from "@/domain/expenses";
import { parsePounds } from "@/domain/money";

const p = (pounds: string) => parsePounds(pounds)!;
const spent = (pounds: string, voided = false) => ({ amount: p(pounds), voided });
const paid = (kind: "deposit" | "payment" | "refund", pounds: string, voided = false) => ({
  kind,
  amount: p(pounds),
  voided,
});

describe("expenses and net profit (BR-95, BR-96, PHASE9_PLAN §4)", () => {
  it("EX-01: 1,500.50 + 2,000 + 499.50 = 4,000.00 in piasters", () => {
    expect(sumExpenses([spent("1500.50"), spent("2000"), spent("499.50")])).toBe(400_000);
  });

  it("EX-02 / BR-95: a voided expense counts for nothing", () => {
    expect(sumExpenses([spent("1500.50"), spent("2000", true), spent("499.50")])).toBe(200_000);
  });

  it("EX-03 / BR-96: collections 40,000 − a 5,000 refund − 4,000 expenses = 31,000; voided payments are left out", () => {
    const result = profit(
      [paid("deposit", "15000"), paid("payment", "25000"), paid("refund", "5000"), paid("payment", "9000", true)],
      [spent("1500.50"), spent("2000"), spent("499.50")],
    );
    expect(result).toEqual({ collected: p("35000"), expenses: p("4000"), net: p("31000") });
  });

  it("EX-04: expenses larger than the collections give a negative profit", () => {
    expect(profit([paid("payment", "3000")], [spent("4000")]).net).toBe(-p("1000"));
    expect(profit([], [])).toEqual({ collected: 0, expenses: 0, net: 0 });
  });
});
