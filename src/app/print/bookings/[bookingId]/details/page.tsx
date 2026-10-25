import { breakdownOf, PriceBreakdownView } from "@/components/bookings/price-breakdown";
import { PrintToolbar, VenueHeading } from "@/components/printing/print-frame";
import { formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { t } from "@/lib/i18n";
import { formatCairoDateTime, formatCairoTime, formatIsoDate, formatIsoWeekday } from "@/lib/time";
import { getBookingPrintData } from "@/server/dal";

const tb = t.bookings;
const tp = tb.page;

/**
 * P-01 booking details (A4, any status): printed or saved as PDF by the browser (CLAUDE.md
 * rule 10, Q9-04), with the venue's logo (D-70).
 */
export default async function BookingDetailsPrint({ params }: PageProps<"/print/bookings/[bookingId]/details">) {
  const { bookingId } = await params;
  const data = await getBookingPrintData(bookingId);
  const { booking: b, money } = data;
  const breakdown = breakdownOf(b, data.lines);
  const cancelled = b.status === "cancelled";
  const refunded = money.payments
    .filter((pay) => pay.kind === "refund" && !pay.voidedAt)
    .reduce((sum, pay) => sum + pay.amount, 0);

  const rows: [string, React.ReactNode][] = [
    [
      tb.number,
      <span key="no" dir="ltr">
        {b.bookingNo}
      </span>,
    ],
    [tb.status, tb.statuses[b.displayStatus]],
    [tb.space, `${b.spaceName} — ${tb.slotKinds[b.slotKind]}`],
    [
      tb.date,
      `${formatIsoWeekday(b.eventDate)} ${formatIsoDate(b.eventDate)} (${formatCairoTime(b.startsAt)} – ${formatCairoTime(b.endsAt)})`,
    ],
    [tb.customer, b.customerName],
    [
      tp.phones,
      <span key="phones" dir="ltr">
        {[b.customerPhone, b.customerAltPhone].filter(Boolean).join(" / ")}
      </span>,
    ],
    [tp.eventType, b.eventTypeName ?? "—"],
    ...(b.groomName || b.brideName
      ? ([
          [tp.groom, b.groomName ?? "—"],
          [tp.bride, b.brideName ?? "—"],
        ] as [string, string][])
      : []),
    [tp.package, b.packageName ?? "—"],
    [tp.guests, b.guests === null ? "—" : formatCount(b.guests)],
    ...(b.notes ? ([[tp.notes, b.notes]] as [string, string][]) : []),
    [tp.createdBy, `${b.createdByName} — ${formatCairoDateTime(b.createdAt)}`],
  ];

  return (
    <div className="mx-auto w-full max-w-[180mm] bg-white p-6 text-sm text-black">
      <style>{"@page { size: A4; margin: 15mm; }"}</style>
      <PrintToolbar bookingId={b.id} />
      <article data-testid="booking-details-print" className="grid gap-4">
        <VenueHeading venue={data.venue} logoUrl={data.logoUrl} title={t.print.details.title} />
        {cancelled && (
          <p className="border-2 border-black p-1 text-center font-bold">
            {tb.statuses.cancelled} — {b.cancelledAt && formatCairoDateTime(b.cancelledAt)} — {b.cancelReason}
          </p>
        )}
        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-neutral-600">{label}</dt>
              <dd className="break-words whitespace-pre-wrap">{value}</dd>
            </div>
          ))}
        </dl>
        {breakdown && (
          <section className="grid gap-2 break-inside-avoid">
            <h2 className="border-b border-black font-bold">{tp.tabs.items}</h2>
            <PriceBreakdownView breakdown={breakdown} />
          </section>
        )}
        {b.status !== "tentative" && (
          <section className="grid gap-2 break-inside-avoid">
            <h2 className="border-b border-black font-bold">{tp.tabs.payments}</h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 tabular-nums">
              {cancelled ? (
                <>
                  <dt className="text-neutral-600">{t.cancel.retainedLabel}</dt>
                  <dd>{formatPiasters(money.ledger.paid)}</dd>
                  <dt className="text-neutral-600">{t.cancel.refundedLabel}</dt>
                  <dd>{formatPiasters(refunded)}</dd>
                </>
              ) : (
                <>
                  <dt className="text-neutral-600">{t.payments.paid}</dt>
                  <dd data-testid="print-paid">{formatPiasters(money.ledger.paid)}</dd>
                  <dt className="text-neutral-600">{t.payments.remaining}</dt>
                  <dd data-testid="print-remaining">{formatPiasters(money.ledger.remaining)}</dd>
                </>
              )}
            </dl>
            {!cancelled && money.installments.length > 0 && (
              <table className="w-full border-collapse text-start">
                <thead>
                  <tr className="border-b border-black">
                    <th className="py-1 text-start">{t.payments.dueDate}</th>
                    <th className="py-1 text-start">{t.payments.amount}</th>
                    <th className="py-1 text-start">{t.payments.outstanding}</th>
                  </tr>
                </thead>
                <tbody>
                  {money.installments.map((line, index) => (
                    <tr key={index} className="border-b border-neutral-300">
                      <td className="py-1">{formatIsoDate(line.dueDate)}</td>
                      <td className="py-1 tabular-nums">{formatPiasters(line.amount)}</td>
                      <td className="py-1 tabular-nums">
                        {line.outstanding === 0 ? t.payments.states.paid : formatPiasters(line.outstanding)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </article>
    </div>
  );
}
