"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { InstallmentState } from "@/domain/installments";
import { formatPiasters } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { formatIsoDate } from "@/lib/time";
import type { PaymentFormOptions } from "@/modules/payments/queries";
import { RecordPaymentDialog, STATE_STYLES } from "./payments-panel";

const tp = t.payments;
const tc = tp.collections;

export type CollectionRow = {
  bookingId: string;
  bookingNo: string;
  customerName: string;
  customerPhone: string;
  spaceName: string;
  eventDate: string;
  dueDate: string;
  amount: number;
  outstanding: number;
  state: InstallmentState;
  remaining: number;
};

/** S-09 rows with "record a payment" on each line (UF-05), then the receipt to print. */
export function CollectionsTable({ rows, options }: { rows: CollectionRow[]; options: PaymentFormOptions }) {
  const router = useRouter();
  const [paying, setPaying] = useState<CollectionRow | null>(null);
  const [recorded, setRecorded] = useState<{ paymentId: string; receiptNo: string } | null>(null);

  return (
    <div className="grid gap-3">
      {recorded && (
        <Alert data-testid="payment-recorded">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {fill(tp.done, { receipt: recorded.receiptNo })}
            <Button asChild size="sm" variant="outline">
              <Link href={`/print/receipts/${recorded.paymentId}?size=80`} target="_blank">
                <Printer />
                {tp.print80}
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/print/receipts/${recorded.paymentId}?size=a4`} target="_blank">
                <Printer />
                {tp.printA4}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table data-testid="collections-table">
          <TableHeader>
            <TableRow>
              <TableHead>{tp.dueDate}</TableHead>
              <TableHead>{tc.booking}</TableHead>
              <TableHead>{tc.customer}</TableHead>
              <TableHead>{tc.eventDate}</TableHead>
              <TableHead>{tp.amount}</TableHead>
              <TableHead>{tp.outstanding}</TableHead>
              <TableHead>{t.bookings.status}</TableHead>
              <TableHead>{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground">
                  {tc.empty}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={`${row.bookingId}-${row.dueDate}-${row.amount}`} data-testid="collection-row">
                <TableCell className="whitespace-nowrap">{formatIsoDate(row.dueDate)}</TableCell>
                <TableCell>
                  <Link href={`/bookings/${row.bookingId}`} className="underline-offset-4 hover:underline" dir="ltr">
                    {row.bookingNo}
                  </Link>
                </TableCell>
                <TableCell>
                  {row.customerName}{" "}
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {row.customerPhone}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatIsoDate(row.eventDate)} — {row.spaceName}
                </TableCell>
                <TableCell className="tabular-nums">{formatPiasters(row.amount)}</TableCell>
                <TableCell className="tabular-nums">{formatPiasters(row.outstanding)}</TableCell>
                <TableCell className={STATE_STYLES[row.state]}>{tp.states[row.state]}</TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" onClick={() => setPaying(row)} data-testid="collect">
                    {tp.record}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {paying && (
        <RecordPaymentDialog
          booking={{ id: paying.bookingId, bookingNo: paying.bookingNo }}
          remaining={paying.remaining}
          options={options}
          onClose={() => setPaying(null)}
          onRecorded={setRecorded}
          onDone={() => {
            setPaying(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
