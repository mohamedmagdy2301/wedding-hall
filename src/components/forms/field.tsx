import { useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionError } from "@/server/action-core";

type FieldProps = Omit<React.ComponentProps<typeof Input>, "id"> & {
  label: string;
  error?: string;
  hint?: string;
};

/** Labelled input with its field error, linked for screen readers. */
export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The action's general message (field errors are shown next to their fields). */
export function FormError({ error }: { error: ActionError | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
