"use client";

import { useId, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/i18n";
import type { RoleListItem } from "@/modules/users-rbac/roles";
import type { UserListItem } from "@/modules/users-rbac/users";
import { createUserAction, updateUserAction } from "@/server/actions/users";
import { canGrantRole } from "./grants";
import type { StaffMe } from "./staff-screen";

type Props = {
  me: StaffMe;
  roles: RoleListItem[];
  /** Absent: create a new user. */
  user?: UserListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function UserDialog({ me, roles, user, open, onOpenChange }: Props) {
  const create = useServerAction(createUserAction);
  const update = useServerAction(updateUserAction);
  const { pending, error } = user ? update : create;
  const [roleIds, setRoleIds] = useState<string[]>(user?.roleIds ?? []);
  const rolesLabelId = useId();
  // P1-11: nobody changes another owner's login.
  const loginLocked = Boolean(user?.isOwner && user.id !== me.id);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const done = () => onOpenChange(false);
    const base = { name: form.get("name"), login: loginLocked ? user?.login : form.get("login"), roleIds };
    if (user) update.run({ ...base, userId: user.id }, done);
    else create.run({ ...base, tempPassword: form.get("tempPassword") }, done);
  }

  const toggle = (id: string, checked: boolean) =>
    setRoleIds((current) => (checked ? [...current, id] : current.filter((r) => r !== id)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? t.staff.editUser : t.staff.addUser}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field label={t.staff.name} name="name" defaultValue={user?.name} error={error?.fieldErrors?.name} />
          <Field
            label={t.staff.login}
            name="login"
            dir="ltr"
            className="text-start"
            defaultValue={user?.login}
            disabled={loginLocked}
            error={error?.fieldErrors?.login}
          />
          {!user && (
            <Field
              label={t.staff.tempPassword}
              name="tempPassword"
              type="password"
              autoComplete="new-password"
              dir="ltr"
              hint={t.staff.tempPasswordHint}
              error={error?.fieldErrors?.tempPassword}
            />
          )}
          {!user?.isOwner && (
            <fieldset className="grid gap-2" aria-labelledby={rolesLabelId}>
              <legend id={rolesLabelId} className="text-sm font-medium">
                {t.staff.roles}
              </legend>
              {roles.map((role) => {
                const held = user?.roleIds.includes(role.id) ?? false;
                const grantable = held || canGrantRole(me, role);
                const id = `role-${role.id}`;
                return (
                  <div key={role.id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={roleIds.includes(role.id)}
                      disabled={!grantable}
                      onCheckedChange={(checked) => toggle(role.id, checked === true)}
                    />
                    <Label htmlFor={id} className="font-normal" title={grantable ? undefined : t.staff.notGrantable}>
                      {role.name}
                    </Label>
                  </div>
                );
              })}
            </fieldset>
          )}
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
