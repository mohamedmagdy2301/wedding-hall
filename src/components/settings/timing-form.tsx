"use client";

import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { updateTimingAction } from "@/server/actions/settings";
import { useSavedNote } from "./saved-note";

type Props = { bufferMinutes: number; tentativeHoldHours: number; maxBufferMinutes: number | null };

/** S-13 "الوقت الفاصل ومدة المبدئي". The server refuses a buffer that breaks BR-02 (D-51). */
export function TimingForm(props: Props) {
  const { run, pending, error } = useServerAction(updateTimingAction);
  const saved = useSavedNote();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run({ bufferMinutes: form.get("bufferMinutes"), tentativeHoldHours: form.get("tentativeHoldHours") }, saved.flash);
  }

  const maxHint =
    props.maxBufferMinutes === null
      ? t.settings.timing.bufferHint
      : `${t.settings.timing.bufferHint} ${t.settings.timing.maxBuffer} ${props.maxBufferMinutes} ${t.settings.timing.minutes}.`;

  return (
    <form onSubmit={onSubmit} className="grid max-w-xl gap-4" noValidate>
      <FormError error={error?.fieldErrors ? null : error} />
      <Field
        label={t.settings.timing.buffer}
        name="bufferMinutes"
        inputMode="numeric"
        dir="ltr"
        className="text-start"
        defaultValue={props.bufferMinutes}
        hint={maxHint}
        error={error?.fieldErrors?.bufferMinutes}
      />
      <Field
        label={t.settings.timing.hold}
        name="tentativeHoldHours"
        inputMode="numeric"
        dir="ltr"
        className="text-start"
        defaultValue={props.tentativeHoldHours}
        hint={t.settings.timing.holdHint}
        error={error?.fieldErrors?.tentativeHoldHours}
      />
      <p className="text-xs text-muted-foreground">{t.settings.timing.existingBookings}</p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {saved.note}
      </div>
    </form>
  );
}
