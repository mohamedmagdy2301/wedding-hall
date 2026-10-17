import { describe, expect, it } from "vitest";
import { quoteSchema } from "@/modules/pricing/schemas";

/** `pricing.quote` input (D-86, D-87): the discount is typed in pounds and read as text into piasters (BR-36). */

const base = {
  spaceId: "11111111-1111-4111-8111-111111111111",
  packageId: "22222222-2222-4222-8222-222222222222",
  slotKind: "evening",
  eventDate: "2027-01-15",
  guests: "200",
};

const discount = (discountAmount: unknown) => quoteSchema.safeParse({ ...base, discountAmount });

describe("pricing.quote discount: pounds → piasters without floating point (BR-36)", () => {
  it.each([
    ["1234.56", 123_456],
    ["0.1", 10],
    ["19.99", 1_999],
    ["١٢٣٤٫٥٦", 123_456],
    ["1,234.56", 123_456],
    ["10000", 1_000_000],
    ["", 0],
    [undefined, 0],
  ])("%s → %i piasters", (input, piasters) => {
    expect(discount(input)).toMatchObject({ success: true, data: { discountAmount: piasters } });
  });

  it.each(["1234.565", "-5", "0.001", "abc", "1e3"])("refuses %s (at most 2 decimals, never negative)", (input) => {
    expect(discount(input)).toMatchObject({ success: false });
  });

  it("a number is read through its text too, so 19.99 is exactly 1999", () => {
    expect(discount(19.99)).toMatchObject({ success: true, data: { discountAmount: 1_999 } });
  });
});
