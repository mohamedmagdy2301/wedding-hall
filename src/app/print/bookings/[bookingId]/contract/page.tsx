import { breakdownOf, PriceBreakdownView } from "@/components/bookings/price-breakdown";
import { PrintToolbar, VenueHeading } from "@/components/printing/print-frame";
import { tierRanges } from "@/domain/cancellation-tiers";
import { formatBps, formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import { formatCairoDateTime, formatCairoTime, formatIsoDate, formatIsoWeekday } from "@/lib/time";
import { getBookingPrintData } from "@/server/dal";

const tb = t.bookings;
const tc = t.print.contract;

/**
 * P-02 the contract (A4) of a confirmed booking — a cancelled one prints with its
 * cancellation. The cancellation policy is the one fixed with the booking at confirmation
 * (D-68), not the venue's current one. A fixed text: there is no contract editor (PRD §9).
 */
export default async function ContractPrint({ params }: PageProps<"/print/bookings/[bookingId]/contract">) {
  const { bookingId } = await params;
  const data = await getBookingPrintData(bookingId);
  const { booking: b, money, policy } = data;

  if (b.status === "tentative" || !policy) {
    return (
      <div className="mx-auto w-full max-w-[180mm] bg-white p-6 text-sm text-black">
        <PrintToolbar bookingId={b.id} />
        <p data-testid="contract-unavailable">{tc.onlyConfirmed}</p>
      </div>
    );
  }

  const breakdown = breakdownOf(b, data.lines);
  const deposit = money.payments.find((pay) => pay.kind === "deposit" && !pay.voidedAt);
  const basis = tc.tierBasis[policy.basis];
  const event = b.eventTypeName ?? tc.eventType;

  const rows: [string, React.ReactNode][] = [
    [
      tb.number,
      <span key="no" dir="ltr">
        {b.bookingNo}
      </span>,
    ],
    [
      tc.date,
      `${formatIsoWeekday(b.eventDate)} ${formatIsoDate(b.eventDate)} (${formatCairoTime(b.startsAt)} – ${formatCairoTime(b.endsAt)})`,
    ],
    [tc.space, `${b.spaceName} — ${tb.slotKinds[b.slotKind]}`],
    [tc.eventType, b.eventTypeName ?? "—"],
    ...(b.groomName || b.brideName
      ? ([[tc.groomBride, `${b.groomName ?? "—"} / ${b.brideName ?? "—"}`]] as [string, string][])
      : []),
    [tc.packageLine, b.packageName ?? "—"],
    [tc.guests, b.guests === null ? "—" : formatCount(b.guests)],
  ];

  return (
    <div className="mx-auto w-full max-w-[180mm] bg-white p-6 text-sm leading-relaxed text-black">
      <style>{"@page { size: A4; margin: 15mm; }"}</style>
      <PrintToolbar bookingId={b.id} />
      <article data-testid="contract-print" className="grid gap-4">
        <VenueHeading venue={data.venue} logoUrl={data.logoUrl} title={tc.title} />
        {b.status === "cancelled" && (
          <p className="border-2 border-black p-1 text-center font-bold" data-testid="contract-cancelled">
            {fill(tc.cancelled, {
              at: b.cancelledAt ? formatCairoDateTime(b.cancelledAt) : "—",
              reason: b.cancelReason ?? "—",
            })}
          </p>
        )}

        <section className="grid gap-2 sm:grid-cols-2 print:grid-cols-2">
          <div className="grid gap-0.5">
            <h2 className="font-bold">{tc.firstParty}</h2>
            <p>{data.venue.name}</p>
            {data.venue.phone && (
              <p>
                {tc.phone}: <span dir="ltr">{data.venue.phone}</span>
              </p>
            )}
            {data.venue.address && (
              <p>
                {tc.address}: {data.venue.address}
              </p>
            )}
          </div>
          <div className="grid gap-0.5">
            <h2 className="font-bold">{tc.secondParty}</h2>
            <p>{b.customerName}</p>
            <p>
              {tc.phone}: <span dir="ltr">{[b.customerPhone, b.customerAltPhone].filter(Boolean).join(" / ")}</span>
            </p>
          </div>
        </section>

        <p>{fill(tc.intro, { space: b.spaceName, event })}</p>

        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-neutral-600">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        {breakdown && (
          <section className="grid gap-2 break-inside-avoid">
            <h2 className="border-b border-black font-bold">{tc.items}</h2>
            <PriceBreakdownView breakdown={breakdown} />
          </section>
        )}

        <section className="grid gap-2 break-inside-avoid">
          <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 tabular-nums">
            <dt className="text-neutral-600">{tc.total}</dt>
            <dd className="font-bold" data-testid="contract-total">
              {formatPiasters(b.total ?? 0)}
            </dd>
            <dt className="text-neutral-600">{tc.deposit}</dt>
            <dd>{deposit ? `${formatPiasters(deposit.amount)} — ${formatCairoDateTime(deposit.paidAt)}` : "—"}</dd>
          </dl>
          <h3 className="font-bold">{tc.schedule}</h3>
          {money.installments.length === 0 ? (
            <p>{tc.noSchedule}</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-black">
                  <th className="py-1 text-start">{t.payments.dueDate}</th>
                  <th className="py-1 text-start">{t.payments.amount}</th>
                </tr>
              </thead>
              <tbody>
                {money.installments.map((line, index) => (
                  <tr key={index} className="border-b border-neutral-300">
                    <td className="py-1">{formatIsoDate(line.dueDate)}</td>
                    <td className="py-1 tabular-nums">{formatPiasters(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="grid gap-1 break-inside-avoid" data-testid="contract-policy">
          <h2 className="border-b border-black font-bold">{tc.policy}</h2>
          <ul className="grid list-disc gap-0.5 ps-5">
            {tierRanges(policy.tiers).map((range) => (
              <li key={range.fromDays}>
                {range.toDays === null
                  ? range.fromDays === 0
                    ? tc.tierAny
                    : fill(tc.tierFrom, { days: formatCount(range.fromDays) })
                  : range.fromDays === 0
                    ? fill(tc.tierBelow, { days: formatCount(range.toDays + 1) })
                    : fill(tc.tierRange, { from: formatCount(range.fromDays), to: formatCount(range.toDays) })}
                :{" "}
                {range.refundBps === 0
                  ? tc.tierNothing
                  : fill(tc.tierRefund, { percent: formatBps(range.refundBps), basis })}
              </li>
            ))}
          </ul>
          <p>{tc.postpone}</p>
        </section>

        <section className="mt-6 grid grid-cols-2 gap-8 break-inside-avoid" data-testid="contract-signatures">
          {[tc.signFirst, tc.signSecond].map((label) => (
            <div key={label} className="grid gap-6">
              <p className="font-bold">{label}</p>
              <p className="border-b border-dotted border-black pb-1">{tc.name}:</p>
              <p className="border-b border-dotted border-black pb-1">{tc.signature}:</p>
            </div>
          ))}
        </section>
      </article>
    </div>
  );
}
