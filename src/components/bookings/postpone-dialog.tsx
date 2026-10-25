"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreditChoice, creditInput, type CreditMode, type CreditValue } from "@/components/discounts/credit-choice";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { DialogShell } from "@/components/payments/payments-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SLOT_KINDS, type SlotKind } from "@/domain/catalog";
import { formatPiasters, piastersToInput } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { formatCairoTime, formatIsoDate } from "@/lib/time";
import type { PostponePreview } from "@/modules/bookings/postpone";
import type { ActionError } from "@/server/action-core";
import { postponeBookingAction, postponePreviewAction } from "@/server/actions/bookings";

const tp = t.postpone;

type Row = { dueDate: string; amount: string };

/**
 * UF-08 (BR-80..85, D-94, Q8-06): a new date and slot of the same space, priced live by the
 * server; installments after the new eve come as an editable suggestion and are sent; a
 * credit for the customer is settled like any other (D-131).
 */
export function PostponeDialog(props: {
  booking: { id: string; bookingNo: string; eventDate: string; slotKind: SlotKind };
  credit: { mode: CreditMode; methods: { id: string; name: string }[] };
  onClose: () => void;
  onDone: () => void;
}) {
  const { booking } = props;
  const [eventDate, setEventDate] = useState(booking.eventDate);
  const [slotKind, setSlotKind] = useState<SlotKind>(booking.slotKind);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [credit, setCredit] = useState<CreditValue>({
    resolution: "refund",
    methodId: props.credit.methods[0]?.id ?? "",
  });
  const [preview, setPreview] = useState<PostponePreview | null>(null);
  const [previewError, setPreviewError] = useState<ActionError | null>(null);
  const [loading, setLoading] = useState(false);
  const save = useServerAction(postponeBookingAction);
  const priceChanged = save.error?.code === "PRICE_CHANGED" ? save.error : null;

  const target = useMemo(
    () => ({ bookingId: booking.id, eventDate, slotKind, startTime, endTime }),
    [booking.id, eventDate, slotKind, startTime, endTime],
  );

  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      const result = await postponePreviewAction(target);
      if (!current) return;
      setLoading(false);
      if (result.ok) {
        setPreview(result.data);
        setPreviewError(null);
        // BR-84: the suggested schedule to edit, only when installments fall after the new eve.
        setRows(
          result.data.lateInstallments.length > 0
            ? result.data.suggestedInstallments.map((l) => ({ dueDate: l.dueDate, amount: piastersToInput(l.amount) }))
            : null,
        );
      } else {
        setPreview(null);
        setPreviewError(result.error);
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [target, priceChanged]);

  const errors = save.error?.fieldErrors ?? {};
  const blocked = preview !== null && preview.confirmedConflicts.length > 0;

  return (
    <DialogShell
      testId="postpone-dialog"
      title={fill(tp.title, { no: booking.bookingNo })}
      description={tp.hint}
      onClose={props.onClose}
      footer={
        <Button
          disabled={save.pending || loading || !preview || blocked}
          data-testid="postpone-submit"
          onClick={() =>
            preview &&
            save.run(
              {
                ...target,
                version: preview.version,
                expectedTotal: preview.totalAfter,
                ...(rows ? { installments: rows } : {}),
                ...creditInput(preview.credit, preview.creditMode, credit),
              },
              props.onDone,
            )
          }
        >
          {save.pending ? t.common.saving : tp.submit}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          label={tp.date}
          type="date"
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
          error={errors.eventDate}
          data-testid="postpone-date"
        />
        <div className="grid gap-1.5">
          <Label>{tp.slot}</Label>
          <Select value={slotKind} onValueChange={(v) => setSlotKind(v as SlotKind)}>
            <SelectTrigger className="w-full" data-testid="postpone-slot">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLOT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t.bookings.slotKinds[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field label={tp.startTime} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        <Field
          label={tp.endTime}
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          error={errors.endTime}
        />
      </div>

      {loading && <p className="text-sm text-muted-foreground">{tp.loading}</p>}
      {previewError && <FormError error={previewError} />}
      {preview && (
        <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm" data-testid="postpone-preview">
          <p className="text-muted-foreground">
            {formatIsoDate(eventDate)} ({formatCairoTime(preview.startsAt)} – {formatCairoTime(preview.endsAt)})
          </p>
          <div className="flex justify-between">
            <span>
              {tp.basePrice} ({preview.seasonName ? fill(tp.season, { name: preview.seasonName }) : tp.regular})
            </span>
            <span className="tabular-nums">
              {formatPiasters(preview.basePriceBefore)} ← {formatPiasters(preview.basePriceAfter)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>{tp.before}</span>
            <span className="tabular-nums">{formatPiasters(preview.totalBefore)}</span>
          </div>
          <div className="flex justify-between font-bold" data-testid="postpone-total-after">
            <span>{tp.after}</span>
            <span className="tabular-nums">{formatPiasters(preview.totalAfter)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{tp.difference}</span>
            <span className="tabular-nums">{formatPiasters(preview.totalAfter - preview.totalBefore)}</span>
          </div>
          {blocked && (
            <Alert variant="destructive" data-testid="postpone-conflict">
              <AlertTriangle />
              <AlertDescription>
                {fill(tp.conflict, { numbers: preview.confirmedConflicts.map((c) => c.bookingNo).join("، ") })}
              </AlertDescription>
            </Alert>
          )}
          {preview.tentativeOverlaps.length > 0 && (
            <Alert>
              <AlertTriangle />
              <AlertDescription>
                {fill(tp.tentativeOverlap, { numbers: preview.tentativeOverlaps.map((c) => c.bookingNo).join("، ") })}
              </AlertDescription>
            </Alert>
          )}
          {rows ? (
            <div className="grid gap-1.5" data-testid="postpone-schedule">
              <p className="text-muted-foreground">{tp.lateInstallments}</p>
              {rows.map((row, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    aria-label={tp.dueDate}
                    value={row.dueDate}
                    onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, dueDate: e.target.value } : r)))}
                  />
                  <Input
                    inputMode="decimal"
                    aria-label={tp.amount}
                    value={row.amount}
                    onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                  />
                </div>
              ))}
            </div>
          ) : (
            preview.suggestedInstallments.length > 0 && (
              <div>
                <p className="text-muted-foreground">{tp.schedule}</p>
                <ul className="ps-4">
                  {preview.suggestedInstallments.map((l, i) => (
                    <li key={i} className="tabular-nums">
                      {formatIsoDate(l.dueDate)} — {formatPiasters(l.amount)}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
          {preview.credit > 0 && (
            <CreditChoice
              credit={preview.credit}
              mode={preview.creditMode}
              methods={props.credit.methods}
              value={credit}
              onChange={setCredit}
              error={errors["credit.methodId"]}
            />
          )}
        </div>
      )}
      {priceChanged ? (
        <Alert variant="destructive">
          <AlertDescription>{tp.priceChanged}</AlertDescription>
        </Alert>
      ) : (
        <FormError error={save.error} />
      )}
    </DialogShell>
  );
}
