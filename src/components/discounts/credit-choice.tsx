"use client";

import { AlertTriangle } from "lucide-react";
import { MethodSelect } from "@/components/payments/method-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { formatPiasters } from "@/domain/money";
import { fill, t } from "@/lib/i18n";

const ta = t.amend;

export type CreditMode = "refund" | "services" | "both";
export type CreditValue = { resolution: "refund" | "services"; methodId: string };

/** The resolution the server will apply: the venue's mode, or the staff member's choice under `both` (D-36). */
export const effectiveResolution = (mode: CreditMode, value: CreditValue) =>
  mode === "both" ? value.resolution : mode;

/**
 * BR-83, D-36: what happens to a credit a lower total leaves for the customer — refunded in
 * the same operation (with its method), or kept on the booking for services.
 */
export function CreditChoice(props: {
  credit: number;
  mode: CreditMode;
  methods: { id: string; name: string }[];
  value: CreditValue;
  onChange: (value: CreditValue) => void;
  error?: string;
}) {
  const { mode, value } = props;
  const resolution = effectiveResolution(mode, value);
  return (
    <div className="grid gap-2" data-testid="credit-choice">
      <Alert>
        <AlertTriangle />
        <AlertDescription>{fill(ta.credit, { amount: formatPiasters(props.credit) })}</AlertDescription>
      </Alert>
      {mode === "both" ? (
        <fieldset className="grid gap-1.5 text-sm">
          {(["refund", "services"] as const).map((option) => (
            <Label key={option} className="flex items-center gap-2 font-normal">
              <input
                type="radio"
                name="credit-resolution"
                value={option}
                checked={value.resolution === option}
                onChange={() => props.onChange({ ...value, resolution: option })}
                data-testid={`credit-${option}`}
              />
              {option === "refund" ? ta.creditRefund : ta.creditServices}
            </Label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-muted-foreground">
          {mode === "refund" ? ta.creditModeRefund : ta.creditModeServices}
        </p>
      )}
      {resolution === "refund" && (
        <MethodSelect
          methods={props.methods}
          value={value.methodId}
          onChange={(methodId) => props.onChange({ ...value, methodId })}
          error={props.error}
        />
      )}
    </div>
  );
}

/** The `credit` field of the request: only when there is a credit to settle. */
export const creditInput = (credit: number, mode: CreditMode, value: CreditValue) =>
  credit > 0
    ? {
        credit: {
          resolution: effectiveResolution(mode, value),
          methodId: effectiveResolution(mode, value) === "refund" ? value.methodId : "",
        },
      }
    : {};
