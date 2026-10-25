import type { PriceLine } from "@/domain/pricing";
import { formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const tp = t.bookings.price;

export type BreakdownView = {
  basePrice: number;
  seasonal: boolean;
  extraGuests: number;
  extraGuestPrice: number;
  extraGuestsAmount: number;
  // Stored lines may also be phase 7's guest adjustments (D-35).
  lines: (Pick<PriceLine, "name" | "quantity" | "isRemoved" | "isExternal" | "lineTotal" | "pricingType"> & {
    source: PriceLine["source"] | "guest_adjustment";
  })[];
  itemsTotal: number;
  externalFeesTotal: number;
  removalCreditsTotal: number;
  subtotal: number;
  discountAmount: number;
  total: number;
};

/** The stored snapshot of a booking as a breakdown (S-07, P-01, P-02); `null` without a price. */
export function breakdownOf(
  b: {
    total: number | null;
    basePrice: number | null;
    seasonName: string | null;
    guests: number | null;
    baseGuests: number | null;
    extraGuestPrice: number | null;
    extraGuestsAmount: number | null;
    itemsTotal: number | null;
    removalCreditsTotal: number | null;
    discountAmount: number | null;
  },
  lines: (BreakdownView["lines"][number] & { externalFee: number })[],
): BreakdownView | null {
  if (b.total === null) return null;
  return {
    basePrice: b.basePrice ?? 0,
    seasonal: b.seasonName !== null,
    // The snapshot's extra guests (BR-37); guests added after confirmation are lines (D-92).
    extraGuests:
      b.extraGuestPrice && b.extraGuestsAmount
        ? Math.round(b.extraGuestsAmount / b.extraGuestPrice)
        : b.guests !== null && b.baseGuests !== null && !b.extraGuestPrice
          ? Math.max(0, b.guests - b.baseGuests)
          : 0,
    extraGuestPrice: b.extraGuestPrice ?? 0,
    extraGuestsAmount: b.extraGuestsAmount ?? 0,
    lines,
    itemsTotal: b.itemsTotal ?? 0,
    externalFeesTotal: lines.filter((l) => l.isExternal).reduce((sum, l) => sum + l.externalFee, 0),
    removalCreditsTotal: b.removalCreditsTotal ?? 0,
    subtotal: b.total + (b.discountAmount ?? 0),
    discountAmount: b.discountAmount ?? 0,
    total: b.total,
  };
}

function Row({ label, amount, muted, strong }: { label: string; amount: number; muted?: boolean; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3",
        muted && "text-muted-foreground",
        strong && "font-bold",
      )}
    >
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{formatPiasters(amount)}</span>
    </div>
  );
}

/**
 * The price breakdown as the engine returns it (BR-32, D-85): the package price, extra
 * guests, every line (included, removed, added, external), the totals. Used live by the
 * wizard and for the stored price on the booking page.
 */
export function PriceBreakdownView({ breakdown }: { breakdown: BreakdownView }) {
  const b = breakdown;
  return (
    <div className="grid gap-1.5 text-sm" data-testid="price-breakdown">
      <Row label={b.seasonal ? `${tp.basePrice} (${tp.seasonal})` : tp.basePrice} amount={b.basePrice} />
      {b.extraGuests > 0 && (
        <Row
          label={fill(tp.extraGuests, { n: formatCount(b.extraGuests), price: formatPiasters(b.extraGuestPrice) })}
          amount={b.extraGuestsAmount}
        />
      )}
      {b.lines.length > 0 && (
        <ul className="grid gap-1 border-y py-2">
          {b.lines.map((line, index) => {
            const tag =
              line.source === "package"
                ? line.isRemoved
                  ? tp.removed
                  : tp.included
                : line.isExternal
                  ? tp.external
                  : null;
            // Units of a per-unit service; guests covered by an added per-guest one (D-84).
            const counted =
              line.pricingType === "per_unit" || (line.pricingType === "per_guest" && line.source !== "package");
            const quantity = counted && !line.isExternal ? ` ×${formatCount(line.quantity)}` : "";
            return (
              <li
                key={index}
                className={cn("flex items-baseline justify-between gap-3", line.isRemoved && "text-muted-foreground")}
              >
                <span>
                  {line.name}
                  {quantity}
                  {tag && <span className="ms-1 text-xs text-muted-foreground">({tag})</span>}
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {line.source === "package" && !line.isRemoved ? "—" : formatPiasters(line.lineTotal)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {b.itemsTotal > 0 && <Row label={tp.itemsTotal} amount={b.itemsTotal} />}
      {b.externalFeesTotal > 0 && <Row label={tp.externalFees} amount={b.externalFeesTotal} muted />}
      {b.removalCreditsTotal > 0 && <Row label={tp.removalCredits} amount={-b.removalCreditsTotal} />}
      {b.discountAmount > 0 && (
        <>
          <Row label={tp.subtotal} amount={b.subtotal} />
          <Row label={tp.discount} amount={-b.discountAmount} />
        </>
      )}
      <div data-testid="price-total">
        <Row label={tp.total} amount={b.total} strong />
      </div>
    </div>
  );
}
