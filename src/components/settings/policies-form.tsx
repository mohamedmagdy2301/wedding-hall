"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { tierFor } from "@/domain/cancellation-tiers";
import { bpsToInput, formatBps, parsePercent, piastersToInput } from "@/domain/money";
import { toAsciiDigits } from "@/lib/digits";
import { t } from "@/lib/i18n";
import type { VenueSettings } from "@/modules/settings/venue";
import { updatePoliciesAction } from "@/server/actions/settings";
import { useSavedNote } from "./saved-note";

type TierRow = { key: number; minDaysBefore: string; refund: string };

const tp = t.settings.policies;

function SelectField<V extends string>(props: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: Record<V, string>;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <Select value={props.value} onValueChange={(v) => props.onChange(v as V)}>
        <SelectTrigger id={id} className="w-full sm:w-72" data-testid={props.testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(props.options) as V[]).map((key) => (
            <SelectItem key={key} value={key}>
              {props.options[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** S-13 "السياسات": D-19 (deposit), D-20 + BR-77 (tiers and basis), D-22 (postpone credit). */
export function PoliciesForm({ settings }: { settings: VenueSettings }) {
  const { run, pending, error } = useServerAction(updatePoliciesAction);
  const saved = useSavedNote();
  const [depositType, setDepositType] = useState(settings.minDepositType);
  const [depositValue, setDepositValue] = useState(
    settings.minDepositType === "fixed"
      ? piastersToInput(settings.minDepositValue)
      : settings.minDepositType === "percent"
        ? bpsToInput(settings.minDepositValue)
        : "",
  );
  const [basis, setBasis] = useState(settings.cancellationBasis);
  const [postpone, setPostpone] = useState(settings.postponeCreditMode);
  const [nextKey, setNextKey] = useState(settings.tiers.length + 1);
  const [tiers, setTiers] = useState<TierRow[]>(
    settings.tiers.length > 0
      ? [...settings.tiers]
          .reverse()
          .map((tier, i) => ({ key: i, minDaysBefore: String(tier.minDaysBefore), refund: bpsToInput(tier.refundBps) }))
      : [{ key: 0, minDaysBefore: "0", refund: "0" }],
  );
  const [previewDays, setPreviewDays] = useState("45");

  const updateTier = (key: number, patch: Partial<TierRow>) =>
    setTiers((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function addTier() {
    setTiers((rows) => [...rows, { key: nextKey, minDaysBefore: "", refund: "" }]);
    setNextKey((k) => k + 1);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(
      {
        minDepositType: depositType,
        minDepositValue: depositValue,
        cancellationBasis: basis,
        postponeCreditMode: postpone,
        tiers: tiers.map((row) => ({ minDaysBefore: row.minDaysBefore, refundBps: row.refund })),
      },
      saved.flash,
    );
  }

  // Live example of the tiers as typed (BR-71), so the owner sees what the numbers mean.
  const parsedTiers = tiers.flatMap((row) => {
    const days = Number(toAsciiDigits(row.minDaysBefore.trim()));
    const bps = parsePercent(row.refund);
    return row.minDaysBefore.trim() !== "" && Number.isInteger(days) && bps !== null
      ? [{ minDaysBefore: days, refundBps: bps }]
      : [];
  });
  const days = Number(toAsciiDigits(previewDays.trim()));
  const previewTier = Number.isInteger(days) && days >= 0 ? tierFor(parsedTiers, days) : null;
  const fieldError = (path: string) => error?.fieldErrors?.[path];
  const tiersError =
    fieldError("tiers") ?? Object.entries(error?.fieldErrors ?? {}).find(([k]) => k.startsWith("tiers."))?.[1];

  return (
    <form onSubmit={onSubmit} className="grid max-w-3xl gap-8" noValidate>
      <FormError error={error?.fieldErrors ? null : error} />

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-lg font-semibold">{tp.deposit}</legend>
        <SelectField
          label={tp.depositType}
          value={depositType}
          onChange={setDepositType}
          options={tp.depositTypes}
          testId="deposit-type"
        />
        {depositType !== "none" && (
          <Field
            label={depositType === "fixed" ? tp.depositAmount : tp.depositPercent}
            name="minDepositValue"
            inputMode="decimal"
            dir="ltr"
            className="text-start sm:w-72"
            value={depositValue}
            onChange={(e) => setDepositValue(e.target.value)}
            error={fieldError("minDepositValue")}
          />
        )}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-lg font-semibold">{tp.cancellation}</legend>
        <SelectField
          label={tp.basis}
          value={basis}
          onChange={setBasis}
          options={tp.bases}
          testId="cancellation-basis"
        />
        <div className="grid gap-2">
          <p className="text-sm font-medium">{tp.tiers}</p>
          <p className="text-xs text-muted-foreground">{tp.tiersHint}</p>
          {tiers.map((row, index) => (
            <div key={row.key} className="flex flex-wrap items-end gap-2" data-testid={`tier-${index}`}>
              <div className="grid gap-1">
                <Label htmlFor={`tier-days-${row.key}`} className="text-xs">
                  {tp.minDays}
                </Label>
                <Input
                  id={`tier-days-${row.key}`}
                  inputMode="numeric"
                  dir="ltr"
                  className="w-32 text-start"
                  value={row.minDaysBefore}
                  onChange={(e) => updateTier(row.key, { minDaysBefore: e.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`tier-refund-${row.key}`} className="text-xs">
                  {tp.refund}
                </Label>
                <Input
                  id={`tier-refund-${row.key}`}
                  inputMode="decimal"
                  dir="ltr"
                  className="w-28 text-start"
                  value={row.refund}
                  onChange={(e) => updateTier(row.key, { refund: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tp.removeTier}
                disabled={tiers.length === 1}
                onClick={() => setTiers((rows) => rows.filter((r) => r.key !== row.key))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {tiersError && <p className="text-xs text-destructive">{tiersError}</p>}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addTier}>
              <Plus />
              {tp.addTier}
            </Button>
          </div>
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted p-3 text-sm"
            data-testid="tier-preview"
          >
            <span>{tp.preview}</span>
            <span>{tp.previewDays}</span>
            <Input
              aria-label={tp.previewDays}
              inputMode="numeric"
              dir="ltr"
              className="h-8 w-20 bg-background text-start"
              value={previewDays}
              onChange={(e) => setPreviewDays(e.target.value)}
            />
            <span>
              {previewTier
                ? `${tp.previewDaysUnit} ${formatBps(previewTier.refundBps)} ${tp.previewOf} ${tp.bases[basis]}.`
                : tp.previewNone}
            </span>
          </div>
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-lg font-semibold">{tp.postpone}</legend>
        <SelectField
          label={tp.postponeMode}
          value={postpone}
          onChange={setPostpone}
          options={tp.postponeModes}
          testId="postpone-mode"
        />
      </fieldset>

      <p className="text-xs text-muted-foreground">{tp.snapshotNote}</p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {saved.note}
      </div>
    </form>
  );
}
