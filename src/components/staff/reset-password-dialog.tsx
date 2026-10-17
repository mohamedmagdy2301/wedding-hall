"use client";

import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import type { UserListItem } from "@/modules/users-rbac/users";
import { resetUserPasswordAction } from "@/server/actions/users";

type Props = { user: UserListItem; open: boolean; onOpenChange: (open: boolean) => void };

export function ResetPasswordDialog({ user, open, onOpenChange }: Props) {
  const { run, pending, error } = useServerAction(resetUserPasswordAction);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run({ userId: user.id, tempPassword: form.get("tempPassword") }, () => onOpenChange(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t.staff.resetPasswordTitle} — {user.name}
          </DialogTitle>
          <DialogDescription>{t.staff.resetPasswordHint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field
            label={t.staff.tempPassword}
            name="tempPassword"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            error={error?.fieldErrors?.tempPassword}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
