import Link from "next/link";
import { PrintButton } from "@/components/payments/print-button";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCairoDateTime, formatIsoDate } from "@/lib/time";
import { getReceiptPageData } from "@/server/dal";
import { VenueHeading } from "@/components/printing/print-frame";

const tr = t.payments.receipt;

/**
 * P-03 (A4) and P-04 (80 mm thermal) — printed by the browser, no library (CLAUDE.md rule
 * 10, D-127). Paid and remaining are as of the receipt's issuance (D-122); a voided receipt
 * prints with its reason, under the venue's logo (D-70).
 */
export default async function ReceiptPage({ params, searchParams }: PageProps<"/print/receipts/[paymentId]">) {
  const { paymentId } = await params;
  const size = (await searchParams).size === "80" ? "80" : "a4";
  const r = await getReceiptPageData(paymentId);
  const thermal = size === "80";

  const rows: [string, React.ReactNode][] = [
    [
      tr.receiptNo,
      <span key="receipt" dir="ltr">
        {r.receiptNo}
      </span>,
    ],
    [tr.issuedAt, formatCairoDateTime(r.createdAt)],
    [tr.paidAt, formatCairoDateTime(r.paidAt)],
    [
      tr.bookingNo,
      <span key="booking" dir="ltr">
        {r.bookingNo}
      </span>,
    ],
    [tr.customer, r.customerName],
    [tr.event, `${formatIsoDate(r.eventDate)} — ${r.spaceName}`],
    [tr.kind, t.payments.kinds[r.kind]],
    [tr.method, r.methodName],
    [tr.amount, <strong key="amount">{formatPiasters(r.amount)}</strong>],
    [tr.total, formatPiasters(r.total)],
    [tr.paid, formatPiasters(r.paid)],
    [tr.remaining, r.afterCancellation ? tr.bookingCancelled : formatPiasters(r.remaining)],
    [tr.receivedBy, r.receivedByName],
  ];

  return (
    <div
      className={cn(
        "mx-auto bg-white text-black",
        thermal ? "w-[72mm] p-1 text-[12px]" : "w-full max-w-[180mm] p-6 text-sm",
      )}
    >
      <style>{thermal ? "@page { size: 80mm auto; margin: 4mm; }" : "@page { size: A4; margin: 15mm; }"}</style>
      <div className="mb-4 flex flex-wrap gap-2 print:hidden">
        <PrintButton label={tr.print} />
        <Link href={`/bookings/${r.bookingId}`} className="rounded border px-3 py-1.5 text-sm">
          {tr.back}
        </Link>
        <Link href={`?size=${thermal ? "a4" : "80"}`} className="rounded border px-3 py-1.5 text-sm">
          {thermal ? t.payments.printA4 : t.payments.print80}
        </Link>
      </div>
      <article data-testid="receipt" data-size={size} className="grid gap-3 break-inside-avoid">
        <VenueHeading
          venue={{ name: r.venueName, phone: r.venuePhone, address: r.venueAddress }}
          logoUrl={r.logoUrl}
          title={tr.title}
          compact={thermal}
        />
        {r.voidedAt && (
          <p className="border-2 border-black p-1 text-center font-bold" data-testid="receipt-voided">
            {tr.voided} — {tr.voidReason}: {r.voidReason}
          </p>
        )}
        <dl className={cn("grid gap-x-3 gap-y-1", thermal ? "grid-cols-[auto_1fr]" : "grid-cols-[10rem_1fr]")}>
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-neutral-600">{label}</dt>
              <dd className="break-words tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {r.note && <p className="border-t border-black pt-2">{r.note}</p>}
      </article>
    </div>
  );
}
