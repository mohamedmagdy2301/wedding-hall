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
