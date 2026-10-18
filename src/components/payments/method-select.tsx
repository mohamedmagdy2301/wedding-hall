"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/i18n";

/** The venue's active payment methods (settings), with the field's error. */
export function MethodSelect(props: {
  methods: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{t.payments.method}</Label>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger
          id={id}
          className="w-full sm:w-72"
          data-testid="payment-method"
          aria-invalid={props.error ? true : undefined}
        >
          <SelectValue placeholder={t.payments.chooseMethod} />
        </SelectTrigger>
        <SelectContent>
          {props.methods.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {props.error && <p className="text-xs text-destructive">{props.error}</p>}
    </div>
  );
}
