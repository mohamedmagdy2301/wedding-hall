"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPiasters, parsePounds, piastersToInput } from "@/domain/money";
import { addDays } from "@/lib/time";
import { fill, t } from "@/lib/i18n";

const tp = t.payments;

export type ScheduleRow = { dueDate: string; amount: string };

/** Typed rows → what the server takes (pounds as typed; the server converts to piasters). */
export const rowsToInput = (rows: ScheduleRow[]) => rows.map((r) => ({ dueDate: r.dueDate, amount: r.amount }));

export const linesToRows = (lines: { dueDate: string; amount: number }[]): ScheduleRow[] =>
  lines.map((l) => ({ dueDate: l.dueDate, amount: piastersToInput(l.amount) }));

/**
 * The optional installment schedule (BR-65) as editable rows, with the running sum against
 * the total and a "last one = the rest" helper (D-34). The server checks the rules.
 */
export function ScheduleEditor(props: {
  rows: ScheduleRow[];
  onChange: (rows: ScheduleRow[]) => void;
  total: number;
  deposit: number | null;
  eventDate: string;
  errors: Record<string, string>;
}) {
  const { rows, onChange } = props;
  const amounts = rows.map((r) => parsePounds(r.amount) ?? 0);
  const sum = (props.deposit ?? 0) + amounts.reduce((a, b) => a + b, 0);
  const eve = props.eventDate ? addDays(props.eventDate, -1) : "";

  const set = (index: number, patch: Partial<ScheduleRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  function fillLast() {
    if (rows.length === 0) return;
    const others = amounts.slice(0, -1).reduce((a, b) => a + b, 0);
    const rest = props.total - (props.deposit ?? 0) - others;
    if (rest > 0) set(rows.length - 1, { amount: piastersToInput(rest) });
  }

  return (
    <div className="grid gap-2" data-testid="schedule-editor">
      <p className="text-xs text-muted-foreground">{tp.scheduleHint}</p>
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
          <div className="grid gap-1">
            <Input
              type="date"
              aria-label={`${tp.dueDate} ${index + 1}`}
              value={row.dueDate}
              max={eve || undefined}
              onChange={(e) => set(index, { dueDate: e.target.value })}
              aria-invalid={props.errors[`installments.${index}.dueDate`] ? true : undefined}
              data-testid={`installment-date-${index}`}
            />
            {props.errors[`installments.${index}.dueDate`] && (
              <p className="text-xs text-destructive">{props.errors[`installments.${index}.dueDate`]}</p>
            )}
          </div>
          <div className="grid gap-1">
            <Input
              inputMode="decimal"
              aria-label={`${tp.amount} ${index + 1}`}
              value={row.amount}
              onChange={(e) => set(index, { amount: e.target.value })}
              aria-invalid={props.errors[`installments.${index}.amount`] ? true : undefined}
              data-testid={`installment-amount-${index}`}
            />
            {props.errors[`installments.${index}.amount`] && (
              <p className="text-xs text-destructive">{props.errors[`installments.${index}.amount`]}</p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={tp.removeInstallment}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { dueDate: "", amount: "" }])}
          data-testid="add-installment"
        >
          <Plus />
          {tp.addInstallment}
        </Button>
        {rows.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={fillLast} data-testid="fill-last">
            {tp.fillLast}
          </Button>
        )}
      </div>
      {rows.length > 0 && (
        <p className={sum === props.total ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {fill(tp.scheduleSum, { sum: formatPiasters(sum), total: formatPiasters(props.total) })}
        </p>
      )}
      {props.errors.installments && <p className="text-xs text-destructive">{props.errors.installments}</p>}
    </div>
  );
}
