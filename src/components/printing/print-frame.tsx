import Link from "next/link";
import { PrintButton } from "@/components/payments/print-button";
import { t } from "@/lib/i18n";

const tr = t.print;

/** The bar above a printout (hidden on paper): print or save as PDF (Q9-04), back to the booking. */
export function PrintToolbar({ bookingId, children }: { bookingId: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 grid gap-2 print:hidden">
      <div className="flex flex-wrap gap-2">
        <PrintButton label={tr.print} />
        <Link href={`/bookings/${bookingId}`} className="rounded border px-3 py-1.5 text-sm">
          {tr.back}
        </Link>
        {children}
      </div>
      <p className="text-xs text-neutral-600">{tr.pdfHint}</p>
    </div>
  );
}

/** The venue's heading on every printout, with its logo when it has one (D-70). */
export function VenueHeading(props: {
  venue: { name: string; phone: string | null; address: string | null };
  logoUrl: string | null;
  title: string;
  compact?: boolean;
}) {
  return (
    <header className="grid justify-items-center gap-0.5 border-b border-black pb-2 text-center">
      {props.logoUrl && (
        // A short-lived signed link (SEC-30), so no image optimisation or caching.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={props.logoUrl}
          alt=""
          className={
            props.compact ? "mb-1 max-h-12 max-w-[50mm] object-contain" : "mb-1 max-h-20 max-w-[60mm] object-contain"
          }
          data-testid="venue-logo"
        />
      )}
      <h1 className={props.compact ? "text-[15px] font-bold" : "text-xl font-bold"}>{props.venue.name}</h1>
      {props.venue.phone && <p dir="ltr">{props.venue.phone}</p>}
      {props.venue.address && <p>{props.venue.address}</p>}
      <p className="mt-1 font-medium">{props.title}</p>
    </header>
  );
}
