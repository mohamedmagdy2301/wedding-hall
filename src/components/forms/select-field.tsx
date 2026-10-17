"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Labelled select over a fixed set of options, with its field error. */
export function SelectField<V extends string>(props: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: Record<V, string>;
  testId: string;
  disabled?: boolean;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  const note = props.error ?? props.hint;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <Select value={props.value} onValueChange={(v) => props.onChange(v as V)} disabled={props.disabled}>
        <SelectTrigger
          id={id}
          className="w-full sm:w-72"
          data-testid={props.testId}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={note ? `${id}-note` : undefined}
        >
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
      {note && (
        <p id={`${id}-note`} className={props.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {note}
        </p>
      )}
    </div>
  );
}
