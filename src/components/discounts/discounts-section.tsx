"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPiasters } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCairoDateTime } from "@/lib/time";
import { withdrawDiscountAction } from "@/server/actions/discounts";
import { DecideDiscountDialog, RequestDiscountDialog, type CreditContext } from "./discount-dialogs";

const td = t.discounts;

export type DiscountRow = {
  id: string;
  amount: number;
  reason: string;
  source: "request" | "price_override";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requestedById: string;
  requestedByName: string;
  createdAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
};

const STATUS_STYLES: Record<DiscountRow["status"], string> = {
  pending: "text-amber-700 dark:text-amber-300",
  approved: "text-emerald-700 dark:text-emerald-300",
  rejected: "text-destructive",
  withdrawn: "text-muted-foreground",
};

/** S-07 items tab: the booking's discount requests (BR-50..52, D-129) and their actions. */
export function DiscountsSection(props: {
  booking: { id: string; bookingNo: string; status: string; total: number | null };
  discounts: DiscountRow[];
  canRequest: boolean;
  canApprove: boolean;
  userId: string;
  credit: CreditContext;
}) {
  const router = useRouter();
  const { booking } = props;
  const [dialog, setDialog] = useState<
    null | "request" | { decide: DiscountRow; approve: boolean } | { withdraw: DiscountRow }
  >(null);
  const withdraw = useServerAction(withdrawDiscountAction);
  const close = () => setDialog(null);
  const done = () => {
    close();
    router.refresh();
  };
  const open = booking.status !== "cancelled" && booking.total !== null;

  return (
    <div className="grid gap-2" data-testid="discounts-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{td.title}</h3>
        {open && props.canRequest && (
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={() => setDialog("request")}
            data-testid="request-discount"
          >
            {td.request}
          </Button>
        )}
      </div>
      {props.discounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.none}</p>
      ) : (
        <Table data-testid="discounts-table">
          <TableHeader>
            <TableRow>
              <TableHead>{td.amount}</TableHead>
              <TableHead>{td.reason}</TableHead>
              <TableHead>{t.bookings.status}</TableHead>
              <TableHead>{td.requestedBy}</TableHead>
              <TableHead>{td.decidedBy}</TableHead>
              <TableHead>{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.discounts.map((d) => (
              <TableRow key={d.id} data-status={d.status}>
                <TableCell className="whitespace-nowrap tabular-nums">{formatPiasters(d.amount)}</TableCell>
                <TableCell>
                  {d.reason}
                  {d.source === "price_override" && (
                    <span className="block text-xs text-muted-foreground">{td.sources.price_override}</span>
                  )}
                </TableCell>
                <TableCell className={cn(STATUS_STYLES[d.status])}>{td.statuses[d.status]}</TableCell>
                <TableCell>
                  {d.requestedByName}
                  <span className="block text-xs text-muted-foreground">{formatCairoDateTime(d.createdAt)}</span>
                </TableCell>
                <TableCell>
                  {d.decidedByName ?? "—"}
                  {d.decisionNote && <span className="block text-xs text-muted-foreground">{d.decisionNote}</span>}
                </TableCell>
                <TableCell>
                  {d.status === "pending" && (
                    <div className="flex flex-wrap gap-1">
                      {props.canApprove && open && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ decide: d, approve: true })}
                          data-testid="approve-discount"
                        >
                          {td.approve}
                        </Button>
                      )}
                      {props.canApprove && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => setDialog({ decide: d, approve: false })}
                          data-testid="reject-discount"
                        >
                          {td.reject}
                        </Button>
                      )}
                      {(props.canApprove || d.requestedById === props.userId) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ withdraw: d })}
                          data-testid="withdraw-discount"
                        >
                          {td.withdraw}
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialog === "request" && booking.total !== null && (
        <RequestDiscountDialog
          booking={{ id: booking.id, bookingNo: booking.bookingNo, total: booking.total }}
          direct={props.canApprove}
          credit={props.credit}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog !== null && typeof dialog === "object" && "decide" in dialog && (
        <DecideDiscountDialog
          request={dialog.decide}
          booking={booking}
          approve={dialog.approve}
          credit={props.credit}
          onClose={close}
          onDone={done}
        />
      )}
      <ConfirmDialog
        open={dialog !== null && typeof dialog === "object" && "withdraw" in dialog}
        onOpenChange={(o) => !o && close()}
        title={
          dialog !== null && typeof dialog === "object" && "withdraw" in dialog
            ? fill(td.withdrawTitle, { amount: formatPiasters(dialog.withdraw.amount) })
            : ""
        }
        description={td.withdrawDescription}
        confirmLabel={td.withdraw}
        pending={withdraw.pending}
        error={withdraw.error}
        onConfirm={() => {
          if (dialog !== null && typeof dialog === "object" && "withdraw" in dialog) {
            withdraw.run({ requestId: dialog.withdraw.id }, done);
          }
        }}
      />
    </div>
  );
}
