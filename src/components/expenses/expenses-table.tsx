"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPiasters } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { formatIsoDate } from "@/lib/time";
import type { ExpenseRow } from "@/modules/expenses/queries";
import { VoidExpenseDialog } from "./expense-dialogs";

const te = t.expenses;

/** S-11 and the booking's expenses: a voided row stays, struck through, with who voided it and why. */
export function ExpensesTable(props: { rows: ExpenseRow[]; canVoid: boolean; showBooking?: boolean }) {
  const router = useRouter();
  const [voiding, setVoiding] = useState<ExpenseRow | null>(null);
  const showBooking = props.showBooking ?? true;
  return (
    <>
      <Table data-testid="expenses-table">
        <TableHeader>
          <TableRow>
            <TableHead>{te.spentOn}</TableHead>
            <TableHead>{te.category}</TableHead>
            <TableHead>{te.description}</TableHead>
            {showBooking && <TableHead>{te.booking}</TableHead>}
            <TableHead>{te.amount}</TableHead>
            <TableHead>{te.createdBy}</TableHead>
            {props.canVoid && <TableHead>{t.common.actions}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((r) => {
            const voided = r.voidedAt !== null;
            return (
              <TableRow key={r.id} data-testid="expense-row" data-voided={voided || undefined}>
                <TableCell className="whitespace-nowrap">{formatIsoDate(r.spentOn)}</TableCell>
                <TableCell>{r.categoryName}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className={voided ? "line-through" : undefined}>{r.description}</span>
                  {voided && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      <Badge variant="outline" className="me-1">
                        {te.voided}
                      </Badge>
                      {fill(te.voidedBy, { name: r.voidedByName ?? "—", reason: r.voidReason ?? "" })}
                    </span>
                  )}
                </TableCell>
                {showBooking && (
                  <TableCell dir="ltr" className="text-end">
                    {r.bookingId ? (
                      <Link href={`/bookings/${r.bookingId}`} className="underline-offset-4 hover:underline">
                        {r.bookingNo}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                )}
                <TableCell className={voided ? "whitespace-nowrap line-through" : "whitespace-nowrap"}>
                  {formatPiasters(r.amount)}
                </TableCell>
                <TableCell>{r.createdByName}</TableCell>
                {props.canVoid && (
                  <TableCell>
                    {!voided && (
                      <Button size="sm" variant="ghost" onClick={() => setVoiding(r)} data-testid="void-expense">
                        {te.void}
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {voiding && (
        <VoidExpenseDialog
          expense={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
