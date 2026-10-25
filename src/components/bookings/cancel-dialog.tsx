"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { MethodSelect } from "@/components/payments/method-select";
import { DialogShell } from "@/components/payments/payments-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatBps, formatPiasters, parsePounds, piastersToInput } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import type { CancelPreview } from "@/modules/bookings/cancel";
import type { ActionError } from "@/server/action-core";
import { cancelBookingAction, cancelPreviewAction } from "@/server/actions/bookings";

const tc = t.cancel;

/**
 * UF-09 (BR-70..76, Q8-02, Q8-03): the server's suggestion from the booking's own tiers
 * (D-68); the amount may change with a reason; typing the booking number confirms.
 */
export function CancelDialog(props: {
  booking: { id: string; bookingNo: string };
  methods: { id: string; name: string }[];
  canRefund: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { booking } = props;
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [previewError, setPreviewError] = useState<ActionError | null>(null);
  const [amount, setAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [methodId, setMethodId] = useState(props.methods[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const action = useServerAction(cancelBookingAction);

  useEffect(() => {
    let current = true;
    cancelPreviewAction({ bookingId: booking.id }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setPreview(result.data);
        if (result.data.status === "confirmed") setAmount(piastersToInput(result.data.suggested));
      } else setPreviewError(result.error);
    });
    return () => {
      current = false;
    };
  }, [booking.id]);

  const confirmed = preview?.status === "confirmed" ? preview : null;
  const typedAmount = parsePounds(amount.trim() === "" ? "0" : amount);
  const adjusted = confirmed !== null && typedAmount !== confirmed.suggested;
  const refunding = confirmed !== null && (typedAmount ?? 0) > 0;
  const errors = action.error?.fieldErrors ?? {};

  return (
    <DialogShell
      testId="cancel-dialog"
      title={fill(tc.title, { no: booking.bookingNo })}
      onClose={props.onClose}
      footer={
        <Button
          variant="destructive"
          disabled={!preview || action.pending || typed.trim() !== booking.bookingNo}
          data-testid="cancel-submit"
          onClick={() =>
            preview &&
            action.run(
              {
                bookingId: booking.id,
                version: preview.version,
                reason,
                ...(confirmed
                  ? {
                      refundAmount: amount.trim() === "" ? "0" : amount,
                      methodId: refunding ? methodId : "",
                      adjustReason: adjusted ? adjustReason : "",
                    }
                  : {}),
              },
              props.onDone,
            )
          }
        >
          {action.pending ? t.common.saving : tc.submit}
        </Button>
      }
    >
      {!preview && !previewError && <p className="text-sm text-muted-foreground">{tc.loading}</p>}
      <FormError error={previewError} />
      {preview?.status === "tentative" && <p className="text-sm text-muted-foreground">{tc.tentativeHint}</p>}
      {confirmed && (
        <dl
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-sm"
          data-testid="cancel-quote"
        >
          <dt className="text-muted-foreground">{tc.days}</dt>
          <dd className="tabular-nums">{formatCount(confirmed.daysRemaining)}</dd>
          <dt className="text-muted-foreground">{tc.tier}</dt>
          <dd>
            {confirmed.tier
              ? `${formatCount(confirmed.tier.minDaysBefore)} ← ${formatBps(confirmed.refundBps)}`
              : tc.noTier}
          </dd>
          <dt className="text-muted-foreground">
            {confirmed.basisKind === "deposit" ? tc.basisDeposit : tc.basisTotalPaid}
          </dt>
          <dd className="tabular-nums">{formatPiasters(confirmed.basis)}</dd>
          <dt className="text-muted-foreground">{tc.netPaid}</dt>
          <dd className="tabular-nums">{formatPiasters(confirmed.netPaid)}</dd>
          <dt className="font-medium">{tc.suggested}</dt>
          <dd className="font-medium tabular-nums" data-testid="cancel-suggested">
            {formatPiasters(confirmed.suggested)}
          </dd>
        </dl>
      )}
      {confirmed && (
        <>
          <Field
            label={tc.refundAmount}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={tc.refundHint}
            error={errors.refundAmount}
            data-testid="cancel-amount"
          />
          {adjusted && (
            <Field
              label={tc.adjustReason}
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              error={errors.adjustReason}
              maxLength={300}
              data-testid="cancel-adjust-reason"
            />
          )}
          {refunding && (
            <MethodSelect methods={props.methods} value={methodId} onChange={setMethodId} error={errors.methodId} />
          )}
          {refunding && !props.canRefund && (
            <Alert variant="destructive">
              <AlertDescription>{t.errors.messages.refundForbidden}</AlertDescription>
            </Alert>
          )}
          {typedAmount !== null && typedAmount <= Math.max(0, confirmed.netPaid) && (
            <p className="text-sm text-muted-foreground" data-testid="cancel-retained">
              {fill(tc.retained, { amount: formatPiasters(Math.max(0, confirmed.netPaid) - typedAmount) })}
            </p>
          )}
        </>
      )}
      <Field
        label={tc.reason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
        maxLength={300}
        data-testid="cancel-reason"
      />
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertDescription>{tc.warning}</AlertDescription>
      </Alert>
      <Field
        label={fill(tc.typeNumber, { no: booking.bookingNo })}
        dir="ltr"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        data-testid="cancel-type-number"
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}
