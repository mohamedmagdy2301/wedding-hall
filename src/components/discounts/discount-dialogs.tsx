"use client";

import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { DialogShell } from "@/components/payments/payments-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatPiasters, parsePounds } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { decideDiscountAction, requestDiscountAction } from "@/server/actions/discounts";
import { CreditChoice, creditInput, type CreditMode, type CreditValue } from "./credit-choice";

const td = t.discounts;

export type CreditContext = {
  /** Net paid on the booking now (BR-62); 0 for a tentative one. */
  paid: number;
  mode: CreditMode;
  methods: { id: string; name: string }[];
};

const creditAfter = (paid: number, totalAfter: number) => Math.max(0, paid - Math.max(0, totalAfter));

function useCredit(methods: { id: string; name: string }[]) {
  return useState<CreditValue>({ resolution: "refund", methodId: methods[0]?.id ?? "" });
}

/** UF-06: amount and reason; applied at once for an approver (BR-51), with the credit it may leave (BR-83). */
export function RequestDiscountDialog(props: {
  booking: { id: string; bookingNo: string; total: number };
  direct: boolean;
  credit: CreditContext;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useServerAction(requestDiscountAction);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [credit, setCredit] = useCredit(props.credit.methods);
  const errors = action.error?.fieldErrors ?? {};
  const piasters = parsePounds(amount);
  const leaves = props.direct && piasters !== null ? creditAfter(props.credit.paid, props.booking.total - piasters) : 0;
  return (
    <DialogShell
      testId="request-discount-dialog"
      title={fill(td.requestTitle, { no: props.booking.bookingNo })}
      description={props.direct ? td.directHint : td.pendingHint}
      onClose={props.onClose}
      footer={
        <Button
          disabled={action.pending}
          data-testid="discount-submit"
          onClick={() =>
            action.run(
              {
                bookingId: props.booking.id,
                amount,
                reason,
                ...creditInput(leaves, props.credit.mode, credit),
              },
              props.onDone,
            )
          }
        >
          {action.pending ? t.common.saving : td.request}
        </Button>
      }
    >
      <Field
        label={td.amount}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
        data-testid="discount-amount"
      />
      <Field
        label={td.reason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
        maxLength={300}
        data-testid="discount-reason"
      />
      {leaves > 0 && (
        <CreditChoice
          credit={leaves}
          mode={props.credit.mode}
          methods={props.credit.methods}
          value={credit}
          onChange={setCredit}
          error={errors["credit.methodId"]}
        />
      )}
      <FormError error={action.error} />
    </DialogShell>
  );
}

/** Approve (with the credit it may leave — BR-83) or reject a pending request, with an optional note. */
export function DecideDiscountDialog(props: {
  request: { id: string; amount: number; reason: string };
  booking: { bookingNo: string; total: number | null };
  approve: boolean;
  credit: CreditContext;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useServerAction(decideDiscountAction);
  const [note, setNote] = useState("");
  const [credit, setCredit] = useCredit(props.credit.methods);
  const errors = action.error?.fieldErrors ?? {};
  const leaves =
    props.approve && props.booking.total !== null
      ? creditAfter(props.credit.paid, props.booking.total - props.request.amount)
      : 0;
  const labels = { amount: formatPiasters(props.request.amount), no: props.booking.bookingNo };
  return (
    <DialogShell
      testId="decide-discount-dialog"
      title={fill(props.approve ? td.approveTitle : td.rejectTitle, labels)}
      description={props.request.reason}
      onClose={props.onClose}
      footer={
        <Button
          variant={props.approve ? "default" : "destructive"}
          disabled={action.pending}
          data-testid="decide-submit"
          onClick={() =>
            action.run(
              {
                requestId: props.request.id,
                approve: props.approve,
                note,
                ...creditInput(leaves, props.credit.mode, credit),
              },
              props.onDone,
            )
          }
        >
          {action.pending ? t.common.saving : props.approve ? td.approve : td.reject}
        </Button>
      }
    >
      {props.approve && props.booking.total !== null && (
        <Alert>
          <AlertDescription>
            {t.amend.before}: {formatPiasters(props.booking.total)} — {t.amend.after}:{" "}
            {formatPiasters(props.booking.total - props.request.amount)}
          </AlertDescription>
        </Alert>
      )}
      <Field
        label={td.note}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={errors.note}
        maxLength={300}
      />
      {leaves > 0 && (
        <CreditChoice
          credit={leaves}
          mode={props.credit.mode}
          methods={props.credit.methods}
          value={credit}
          onChange={setCredit}
          error={errors["credit.methodId"]}
        />
      )}
      <FormError error={action.error} />
    </DialogShell>
  );
}
