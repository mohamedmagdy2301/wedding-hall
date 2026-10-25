"use client";

import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { updateVenueAction } from "@/server/actions/settings";
import { useSavedNote } from "./saved-note";

type Props = { name: string; phone: string | null; address: string | null };

/** S-13 "بيانات المنشأة"; the logo has its own panel (D-70). */
export function VenueForm(props: Props) {
  const { run, pending, error } = useServerAction(updateVenueAction);
  const saved = useSavedNote();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run({ name: form.get("name"), phone: form.get("phone"), address: form.get("address") }, saved.flash);
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-xl gap-4" noValidate>
      <FormError error={error?.fieldErrors ? null : error} />
      <Field label={t.settings.venue.name} name="name" defaultValue={props.name} error={error?.fieldErrors?.name} />
      <Field
        label={t.settings.venue.phone}
        name="phone"
        dir="ltr"
        className="text-start"
        inputMode="tel"
        defaultValue={props.phone ?? ""}
        hint={t.settings.venue.phoneHint}
        error={error?.fieldErrors?.phone}
      />
      <Field
        label={t.settings.venue.address}
        name="address"
        defaultValue={props.address ?? ""}
        error={error?.fieldErrors?.address}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {saved.note}
      </div>
    </form>
  );
}
