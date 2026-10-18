import Link from "next/link";
import { StatusBadge } from "@/components/bookings/status-badge";
import { CustomerDialog } from "@/components/customers/customer-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import { cairoDate, formatCairoTime, formatIsoDate } from "@/lib/time";
import { getCustomerPageData } from "@/server/dal";

const tc = t.customers;
const tb = t.bookings;

/** S-08 customer page with their bookings and the status shown now (`bookings.view`). */
export default async function CustomerPage({ params }: PageProps<"/customers/[customerId]">) {
  const { customerId } = await params;
  const { customer, bookings, canManage } = await getCustomerPageData(customerId);
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{customer.name}</h1>
        {canManage && (
          <div className="ms-auto">
            <CustomerDialog customer={customer} />
          </div>
        )}
      </div>
      <Card className="py-4">
        <CardContent className="grid gap-1 px-4 text-sm">
          <p>
            <span className="text-muted-foreground">{tc.phone}: </span>
            <span dir="ltr">{[customer.phone, customer.altPhone].filter(Boolean).join(" / ")}</span>
          </p>
          {customer.notes && <p className="whitespace-pre-wrap">{customer.notes}</p>}
        </CardContent>
      </Card>
      <h2 className="text-lg font-bold">{tc.bookings}</h2>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tb.number}</TableHead>
              <TableHead>{tb.date}</TableHead>
              <TableHead>{tb.space}</TableHead>
              <TableHead>{tb.slot}</TableHead>
              <TableHead>{tb.total}</TableHead>
              <TableHead>{tb.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bookings.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {tc.noBookings}
                </TableCell>
              </TableRow>
            )}
            {bookings.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Link href={`/bookings/${b.id}`} className="font-medium underline-offset-4 hover:underline" dir="ltr">
                    {b.bookingNo}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatIsoDate(cairoDate(b.startsAt))}{" "}
                  <span className="text-muted-foreground">{formatCairoTime(b.startsAt)}</span>
                </TableCell>
                <TableCell>{b.spaceName}</TableCell>
                <TableCell>{tb.slotKinds[b.slotKind]}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {b.total === null ? (
                    <span className="text-muted-foreground">{tb.noPrice}</span>
                  ) : (
                    formatPiasters(b.total)
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={b.displayStatus} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
