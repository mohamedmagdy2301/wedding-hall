"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { minimumDeposit } from "@/domain/deposit";
import { formatPiasters, parsePounds, piastersToInput } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import type { PaymentFormOptions } from "@/modules/payments/queries";
import type { ActionError, ActionResult } from "@/server/action-core";
import { MethodSelect } from "./method-select";
import { rowsToInput, ScheduleEditor, type ScheduleRow } from "./schedule-editor";

const tc = t.payments.confirm;

export type ConfirmFields = {
  expectedTotal: number;
  deposit: { amount: string; methodId: string; paidAt: string };
  installments: { dueDate: string; amount: string }[];
};

/**
 * Confirming with a deposit (UF-03 step 6, UF-04): the total at today's prices, the deposit
 * with its minimum (D-119), the method, a past date for whoever may backdate (D-118) and the
 * optional schedule (BR-65). A changed price comes back as PRICE_CHANGED: the new total is
 * shown with the difference and the next press confirms it (D-124).
 */
export function ConfirmDepositDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  total: number;
  eventDate: string;
  options: PaymentFormOptions;
  submit: (fields: ConfirmFields) => Promise<ActionResult<{ id?: string; receiptNo: string }>>;
  onDone: (data: { id?: string; receiptNo: string }) => void;
}) {
  const { options } = props;
  const [total, setTotal] = useState(props.total);
  const [amount, setAmount] = useState(piastersToInput(minimumDeposit(props.total, options.minDeposit)));
  const [methodId, setMethodId] = useState(options.methods[0]?.id ?? "");
  const [paidAt, setPaidAt] = useState("");
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<ActionError | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const minimum = minimumDeposit(total, options.minDeposit);
  const errors = error?.fieldErrors ?? {};
  const deposit = parsePounds(amount);

  async function confirm() {
    setPending(true);
    const result = await props.submit({
      expectedTotal: total,
      deposit: { amount, methodId, paidAt },
      installments: rowsToInput(rows),
    });
    setPending(false);
    if (result.ok) {
      setError(null);
      props.onDone(result.data);
      return;
    }
    if (result.error.code === "PRICE_CHANGED") {
      const next = Number(result.error.details?.total);
      setChanged(
        fill(tc.priceChanged, {
          before: formatPiasters(total),
          after: formatPiasters(next),
          difference: formatPiasters(next - total),
        }),
      );
      setTotal(next);
      setAmount(piastersToInput(minimumDeposit(next, options.minDeposit)));
      setError(null);
      return;
    }
    setError(result.error);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {tc.total}:{" "}
            <span className="font-medium tabular-nums" data-testid="confirm-total">
              {formatPiasters(total)}
            </span>
          </DialogDescription>
        </DialogHeader>
        {changed && (
          <Alert data-testid="price-changed">
            <Info />
            <AlertDescription>{changed}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-3">
          <Field
            label={tc.deposit}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors["deposit.amount"]}
            hint={
              options.minDeposit.minDepositType === "none"
                ? tc.noMinimum
                : fill(tc.minimum, { amount: formatPiasters(minimum) })
            }
            data-testid="deposit-amount"
          />
          <MethodSelect
            methods={options.methods}
            value={methodId}
            onChange={setMethodId}
            error={errors["deposit.methodId"] ?? errors.methodId}
          />
          {options.canBackdate && (
            <Field
              label={tc.paidAt}
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              error={errors.paidAt ?? errors["deposit.paidAt"]}
              hint={tc.paidAtHint}
              data-testid="deposit-paid-at"
            />
          )}
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">{t.payments.schedule}</p>
            <ScheduleEditor
              rows={rows}
              onChange={setRows}
              total={total}
              deposit={deposit}
              eventDate={props.eventDate}
              errors={errors}
            />
          </div>
        </div>
        <FormError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={pending || !methodId} onClick={confirm} data-testid="confirm-submit">
            {pending ? t.common.saving : tc.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
