"use client";

import { AlertTriangle, Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { rebalanceSchedule, type InstallmentState } from "@/domain/installments";
import { formatPiasters, parsePounds } from "@/domain/money";
import type { PaymentKind } from "@/domain/payments";
import { fill, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCairoDateTime, formatIsoDate } from "@/lib/time";
import type { PaymentFormOptions } from "@/modules/payments/queries";
import {
  recordDepositAction,
  recordPaymentAction,
  setInstallmentsAction,
  voidPaymentAction,
} from "@/server/actions/payments";
import { MethodSelect } from "./method-select";
import { linesToRows, rowsToInput, ScheduleEditor, type ScheduleRow } from "./schedule-editor";

const tp = t.payments;

export type PaymentsData = {
  ledger: { total: number; paid: number; remaining: number };
  payments: {
    id: string;
    receiptNo: string;
    kind: PaymentKind;
    amount: number;
    paidAt: Date;
    note: string | null;
    methodName: string;
    receivedByName: string;
    voidedAt: Date | null;
    voidReason: string | null;
    voidedByName: string | null;
  }[];
  installments: { dueDate: string; amount: number; covered: number; outstanding: number; state: InstallmentState }[];
  activeDeposit: { id: string; amount: number } | null;
  depositMissing: boolean;
};

export const STATE_STYLES: Record<InstallmentState, string> = {
  paid: "text-emerald-700 dark:text-emerald-300",
  upcoming: "text-muted-foreground",
  dueToday: "text-amber-700 dark:text-amber-300",
  overdue: "text-destructive font-medium",
};

/** S-07 payments tab (UF-05): ledger, schedule with each line's state (BR-66), movements with receipts and voids (BR-64). */
export function PaymentsPanel(props: {
  booking: { id: string; bookingNo: string; version: number; status: string; eventDate: string };
  money: PaymentsData;
  options: PaymentFormOptions | null;
  canVoid: boolean;
}) {
  const router = useRouter();
  const { booking, money, options } = props;
  const open = booking.status === "confirmed";
  const canRecord = options !== null && open;
  const [dialog, setDialog] = useState<
    null | "record" | "deposit" | "schedule" | { void: PaymentsData["payments"][number] }
  >(null);
  const close = () => setDialog(null);
  const done = () => {
    close();
    router.refresh();
  };

  return (
    <div className="grid gap-4" data-testid="payments-panel">
      <div className="grid grid-cols-3 gap-2 text-sm">
        {(["total", "paid", "remaining"] as const).map((key) => (
          <Card key={key} className="py-3">
            <CardContent className="px-3">
              <p className="text-muted-foreground">{tp[key]}</p>
              <p className="font-semibold tabular-nums" data-testid={`ledger-${key}`}>
                {formatPiasters(money.ledger[key])}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {money.depositMissing && (
        <Alert variant="destructive" data-testid="deposit-missing">
          <AlertTriangle />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {tp.depositMissing}
            {canRecord && (
              <Button size="sm" variant="outline" onClick={() => setDialog("deposit")} data-testid="record-deposit">
                {tp.recordDeposit}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {canRecord && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog("record")} data-testid="record-payment">
            {tp.record}
          </Button>
          {!money.depositMissing && (
            <Button variant="outline" onClick={() => setDialog("schedule")} data-testid="edit-schedule">
              {tp.editSchedule}
            </Button>
          )}
        </div>
      )}

      <Card className="py-4">
        <CardContent className="grid gap-2 px-4">
          <h3 className="font-medium">{tp.schedule}</h3>
          {money.installments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tp.noSchedule}</p>
          ) : (
            <Table data-testid="schedule-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{tp.dueDate}</TableHead>
                  <TableHead>{tp.amount}</TableHead>
                  <TableHead>{tp.outstanding}</TableHead>
                  <TableHead>{t.bookings.status}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {money.installments.map((line, index) => (
                  <TableRow key={index} data-state={line.state}>
                    <TableCell>{formatIsoDate(line.dueDate)}</TableCell>
                    <TableCell className="tabular-nums">{formatPiasters(line.amount)}</TableCell>
                    <TableCell className="tabular-nums">{formatPiasters(line.outstanding)}</TableCell>
                    <TableCell className={STATE_STYLES[line.state]}>{tp.states[line.state]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="grid gap-2 px-4">
          <h3 className="font-medium">{tp.movements}</h3>
          {money.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tp.noMovements}</p>
          ) : (
            <Table data-testid="payments-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{tp.receiptNo}</TableHead>
                  <TableHead>{tp.amount}</TableHead>
                  <TableHead>{t.payments.receipt.kind}</TableHead>
                  <TableHead>{tp.paidAt}</TableHead>
                  <TableHead>{tp.method}</TableHead>
                  <TableHead>{tp.receivedBy}</TableHead>
                  <TableHead>{t.common.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {money.payments.map((pay) => (
                  <TableRow
                    key={pay.id}
                    data-receipt={pay.receiptNo}
                    className={cn(pay.voidedAt && "text-muted-foreground")}
                  >
                    <TableCell dir="ltr" className="text-end">
                      {pay.receiptNo}
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap tabular-nums", pay.voidedAt && "line-through")}>
                      {formatPiasters(pay.amount)}
                    </TableCell>
                    <TableCell>
                      {tp.kinds[pay.kind]}
                      {pay.voidedAt && (
                        <span className="block text-xs text-destructive">
                          {tp.voided} —{" "}
                          {fill(tp.voidedBy, { name: pay.voidedByName ?? "", reason: pay.voidReason ?? "" })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{formatCairoDateTime(pay.paidAt)}</TableCell>
                    <TableCell>{pay.methodName}</TableCell>
                    <TableCell>{pay.receivedByName}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/print/receipts/${pay.id}?size=a4`} target="_blank" data-testid="print-a4">
                            <Printer />
                            {tp.printA4}
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/print/receipts/${pay.id}?size=80`} target="_blank" data-testid="print-80">
                            <Printer />
                            {tp.print80}
                          </Link>
                        </Button>
                        {props.canVoid && !pay.voidedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => setDialog({ void: pay })}
                            data-testid="void-payment"
                          >
                            {tp.void}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {options && dialog === "record" && (
        <RecordPaymentDialog
          booking={booking}
          remaining={money.ledger.remaining}
          options={options}
          onClose={close}
          onDone={done}
        />
      )}
      {options && dialog === "deposit" && (
        <RecordDepositDialog booking={booking} money={money} options={options} onClose={close} onDone={done} />
      )}
      {dialog === "schedule" && <ScheduleDialog booking={booking} money={money} onClose={close} onDone={done} />}
      {dialog !== null && typeof dialog === "object" && (
        <VoidDialog payment={dialog.void} onClose={close} onDone={done} />
      )}
    </div>
  );
}

type DialogProps = { onClose: () => void; onDone: () => void };

function DialogShell(props: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  testId: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid={props.testId}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-3">{props.children}</div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            {t.common.cancel}
          </Button>
          {props.footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** UF-05: amount, method, a past date for whoever may backdate (D-118), a note. */
export function RecordPaymentDialog(
  props: DialogProps & {
    booking: { id: string; bookingNo: string };
    remaining: number;
    options: PaymentFormOptions;
    onRecorded?: (receipt: { paymentId: string; receiptNo: string }) => void;
  },
) {
  const action = useServerAction(recordPaymentAction);
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState(props.options.methods[0]?.id ?? "");
  const [paidAt, setPaidAt] = useState("");
  const [note, setNote] = useState("");
  const errors = action.error?.fieldErrors ?? {};
  return (
    <DialogShell
      testId="record-payment-dialog"
      title={fill(tp.recordTitle, { no: props.booking.bookingNo })}
      description={fill(tp.recordHint, { amount: formatPiasters(props.remaining) })}
      onClose={props.onClose}
      footer={
        <Button
          disabled={action.pending || !methodId}
          data-testid="record-submit"
          onClick={() =>
            action.run({ bookingId: props.booking.id, amount, methodId, paidAt, note }, (data) => {
              props.onRecorded?.(data);
              props.onDone();
            })
          }
        >
          {action.pending ? t.common.saving : tp.record}
        </Button>
      }
    >
      <Field
        label={tp.amount}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
        data-testid="payment-amount"
      />
      <MethodSelect methods={props.options.methods} value={methodId} onChange={setMethodId} error={errors.methodId} />
      {props.options.canBackdate && (
        <Field
          label={t.payments.confirm.paidAt}
          type="date"
          value={paidAt}
          onChange={(e) => setPaidAt(e.target.value)}
          error={errors.paidAt}
          hint={t.payments.confirm.paidAtHint}
        />
      )}
      <Field
        label={tp.note}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={errors.note}
        maxLength={300}
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}

/** D-40, D-121: a replacement deposit; the schedule is rebalanced unless the staff member edits it. */
function RecordDepositDialog(
  props: DialogProps & {
    booking: { id: string; bookingNo: string; eventDate: string };
    money: PaymentsData;
    options: PaymentFormOptions;
  },
) {
  const action = useServerAction(recordDepositAction);
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState(props.options.methods[0]?.id ?? "");
  const [paidAt, setPaidAt] = useState("");
  const [manual, setManual] = useState(false);
  const [rows, setRows] = useState<ScheduleRow[]>(linesToRows(props.money.installments));
  const errors = action.error?.fieldErrors ?? {};
  const deposit = parsePounds(amount);
  const total = props.money.ledger.total;
  const preview =
    props.money.installments.length > 0 && deposit !== null && deposit > 0
      ? rebalanceSchedule(props.money.installments, total - deposit)
      : null;

  return (
    <DialogShell
      testId="record-deposit-dialog"
      title={fill(tp.recordDepositTitle, { no: props.booking.bookingNo })}
      description={tp.recordDepositHint}
      onClose={props.onClose}
      footer={
        <Button
          disabled={action.pending || !methodId}
          data-testid="deposit-submit"
          onClick={() =>
            action.run(
              {
                bookingId: props.booking.id,
                amount,
                methodId,
                paidAt,
                ...(manual ? { installments: rowsToInput(rows) } : {}),
              },
              props.onDone,
            )
          }
        >
          {action.pending ? t.common.saving : tp.recordDeposit}
        </Button>
      }
    >
      <Field
        label={t.payments.confirm.deposit}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
        data-testid="deposit-amount"
      />
      <MethodSelect methods={props.options.methods} value={methodId} onChange={setMethodId} error={errors.methodId} />
      {props.options.canBackdate && (
        <Field
          label={t.payments.confirm.paidAt}
          type="date"
          value={paidAt}
          onChange={(e) => setPaidAt(e.target.value)}
          error={errors.paidAt}
        />
      )}
      {props.money.installments.length > 0 && !manual && (
        <div className="grid gap-1 text-sm" data-testid="rebalance-preview">
          {preview ? (
            <>
              <p className="text-muted-foreground">{tp.rebalanced}</p>
              <ul className="ps-4">
                {preview.map((l, i) => (
                  <li key={i}>
                    {formatIsoDate(l.dueDate)} — {formatPiasters(l.amount)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            deposit !== null && deposit > 0 && <p className="text-destructive">{tp.rebalanceImpossible}</p>
          )}
          <Button type="button" variant="link" className="justify-start px-0" onClick={() => setManual(true)}>
            {tp.editScheduleToo}
          </Button>
        </div>
      )}
      {manual && (
        <ScheduleEditor
          rows={rows}
          onChange={setRows}
          total={total}
          deposit={deposit}
          eventDate={props.booking.eventDate}
          errors={errors}
        />
      )}
      <FormError error={action.error} />
    </DialogShell>
  );
}

/** BR-65, D-126: the whole schedule replaced; an empty one removes it. */
function ScheduleDialog(
  props: DialogProps & {
    booking: { id: string; bookingNo: string; version: number; eventDate: string };
    money: PaymentsData;
  },
) {
  const action = useServerAction(setInstallmentsAction);
  const [rows, setRows] = useState<ScheduleRow[]>(linesToRows(props.money.installments));
  return (
    <DialogShell
      testId="schedule-dialog"
      title={fill(tp.editScheduleTitle, { no: props.booking.bookingNo })}
      onClose={props.onClose}
      footer={
        <Button
          disabled={action.pending}
          data-testid="schedule-submit"
          onClick={() =>
            action.run(
              { bookingId: props.booking.id, version: props.booking.version, installments: rowsToInput(rows) },
              props.onDone,
            )
          }
        >
          {action.pending ? t.common.saving : t.common.save}
        </Button>
      }
    >
      <ScheduleEditor
        rows={rows}
        onChange={setRows}
        total={props.money.ledger.total}
        deposit={props.money.activeDeposit?.amount ?? 0}
        eventDate={props.booking.eventDate}
        errors={action.error?.fieldErrors ?? {}}
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}

/** BR-64: with a reason; the number stays taken. */
function VoidDialog(props: DialogProps & { payment: { id: string; receiptNo: string } }) {
  const action = useServerAction(voidPaymentAction);
  const [reason, setReason] = useState("");
  return (
    <DialogShell
      testId="void-dialog"
      title={fill(tp.voidTitle, { receipt: props.payment.receiptNo })}
      description={tp.voidDescription}
      onClose={props.onClose}
      footer={
        <Button
          variant="destructive"
          disabled={action.pending}
          data-testid="void-submit"
          onClick={() => action.run({ paymentId: props.payment.id, reason }, props.onDone)}
        >
          {action.pending ? t.common.saving : tp.voidConfirm}
        </Button>
      }
    >
      <Field
        label={tp.voidReason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={action.error?.fieldErrors?.reason}
        maxLength={300}
        data-testid="void-reason"
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}
