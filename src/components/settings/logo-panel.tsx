"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/i18n";
import { removeLogoAction, setLogoAction } from "@/server/actions/settings";
import { useSavedNote } from "./saved-note";

const tv = t.settings.venue;

/** D-70, P9-06: the logo shown on the printouts; replacing or removing it deletes the old file. */
export function LogoPanel({ logoUrl }: { logoUrl: string | null }) {
  const router = useRouter();
  const inputId = useId();
  const upload = useServerAction(setLogoAction);
  const remove = useServerAction(removeLogoAction);
  const [file, setFile] = useState<File | null>(null);
  const saved = useSavedNote("logo-saved");
  const done = () => {
    setFile(null);
    saved.flash();
    router.refresh();
  };

  return (
    <section className="grid max-w-xl gap-3" data-testid="logo-panel">
      <h2 className="font-medium">{tv.logo}</h2>
      {logoUrl ? (
        // A short-lived signed link (SEC-30), so no image optimisation.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={tv.logo}
          className="max-h-24 max-w-60 rounded border bg-white object-contain p-2"
          data-testid="logo-preview"
        />
      ) : (
        <p className="text-sm text-muted-foreground">{tv.noLogo}</p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>{tv.chooseLogo}</Label>
        <Input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-invalid={upload.error?.fieldErrors?.file ? true : undefined}
          data-testid="logo-file"
        />
        <p className="text-xs text-muted-foreground">{tv.logoHint}</p>
        {upload.error?.fieldErrors?.file && <p className="text-xs text-destructive">{upload.error.fieldErrors.file}</p>}
      </div>
      <FormError error={upload.error?.fieldErrors ? null : upload.error} />
      <FormError error={remove.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!file || upload.pending}
          onClick={() => file && upload.run({ file }, done)}
          data-testid="logo-upload"
        >
          {upload.pending ? t.common.saving : logoUrl ? tv.replaceLogo : tv.uploadLogo}
        </Button>
        {logoUrl && (
          <Button variant="outline" disabled={remove.pending} onClick={() => remove.run(undefined, done)}>
            {tv.removeLogo}
          </Button>
        )}
        {saved.note}
      </div>
    </section>
  );
}
