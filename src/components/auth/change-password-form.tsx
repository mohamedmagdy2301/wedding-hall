"use client";

import { useRouter } from "next/navigation";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { changePasswordAction } from "@/server/actions/auth";

export function ChangePasswordForm() {
  const router = useRouter();
  const { run, pending, error } = useServerAction(changePasswordAction);
  const fieldErrors = error?.fieldErrors;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(
      {
        currentPassword: form.get("currentPassword"),
        newPassword: form.get("newPassword"),
        confirmPassword: form.get("confirmPassword"),
      },
      () => {
        router.replace("/");
        router.refresh();
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormError error={fieldErrors ? null : error} />
      <Field
        label={t.changePassword.current}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        dir="ltr"
        error={fieldErrors?.currentPassword}
      />
      <Field
        label={t.changePassword.next}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        dir="ltr"
        error={fieldErrors?.newPassword}
      />
      <Field
        label={t.changePassword.confirm}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        dir="ltr"
        error={fieldErrors?.confirmPassword}
      />
      <Button type="submit" disabled={pending}>
        {pending ? t.common.saving : t.changePassword.submit}
      </Button>
    </form>
  );
}
