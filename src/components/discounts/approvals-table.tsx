"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import { formatCairoDateTime, formatIsoDate } from "@/lib/time";
import type { PendingDiscount } from "@/modules/discounts/queries";
import type { CreditMode } from "./credit-choice";
import { DecideDiscountDialog } from "./discount-dialogs";

const td = t.discounts;

/** S-10: pending discount requests, oldest first, approved or rejected from the row (UF-06). */
export function ApprovalsTable(props: {
  rows: PendingDiscount[];
  creditMode: CreditMode;
  methods: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [deciding, setDeciding] = useState<{ row: PendingDiscount; approve: boolean } | null>(null);
  if (props.rows.length === 0) return <p className="text-sm text-muted-foreground">{td.approvalsEmpty}</p>;
  return (
    <>
      <Table data-testid="approvals-table">
        <TableHeader>
          <TableRow>
            <TableHead>{td.booking}</TableHead>
            <TableHead>{td.customer}</TableHead>
            <TableHead>{td.amount}</TableHead>
            <TableHead>{td.reason}</TableHead>
            <TableHead>{td.requestedBy}</TableHead>
            <TableHead>{td.bookingTotal}</TableHead>
            <TableHead>{t.common.actions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((row) => (
            <TableRow key={row.id} data-booking={row.bookingNo}>
              <TableCell>
                <Link href={`/bookings/${row.bookingId}`} dir="ltr" className="underline-offset-4 hover:underline">
                  {row.bookingNo}
                </Link>
                <span className="block text-xs text-muted-foreground">{formatIsoDate(row.eventDate)}</span>
              </TableCell>
              <TableCell>{row.customerName}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{formatPiasters(row.amount)}</TableCell>
              <TableCell>
                {row.reason}
                {row.source === "price_override" && (
                  <span className="block text-xs text-muted-foreground">{td.sources.price_override}</span>
                )}
              </TableCell>
              <TableCell>
                {row.requestedByName}
                <span className="block text-xs text-muted-foreground">{formatCairoDateTime(row.createdAt)}</span>
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {row.total === null ? "—" : formatPiasters(row.total)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.fits && row.bookingStatus !== "cancelled" && (
                    <Button
                      size="sm"
                      onClick={() => setDeciding({ row, approve: true })}
                      data-testid="approve-discount"
                    >
                      {td.approve}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setDeciding({ row, approve: false })}
                    data-testid="reject-discount"
                  >
                    {td.reject}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {deciding && (
        <DecideDiscountDialog
          request={deciding.row}
          booking={{ bookingNo: deciding.row.bookingNo, total: deciding.row.total }}
          approve={deciding.approve}
          credit={{
            // What approving leaves is computed by the server; paid = credit + total after.
            paid: deciding.row.credit + Math.max(0, deciding.row.totalAfter ?? 0),
            mode: props.creditMode,
            methods: props.methods,
          }}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
