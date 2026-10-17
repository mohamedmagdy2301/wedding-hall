"use client";

import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/i18n";
import { PERMISSIONS } from "@/modules/users-rbac/permissions";
import type { RoleListItem } from "@/modules/users-rbac/roles";
import { createRoleAction, updateRoleAction } from "@/server/actions/users";
import { holds } from "./grants";
import type { StaffMe } from "./staff-screen";

type Props = { me: StaffMe; role?: RoleListItem; open: boolean; onOpenChange: (open: boolean) => void };

export function RoleDialog({ me, role, open, onOpenChange }: Props) {
  const create = useServerAction(createRoleAction);
  const update = useServerAction(updateRoleAction);
  const { pending, error } = role ? update : create;
  const [keys, setKeys] = useState<string[]>(role?.permissionKeys ?? []);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const done = () => onOpenChange(false);
    if (role) update.run({ roleId: role.id, name, permissionKeys: keys }, done);
    else create.run({ name, permissionKeys: keys }, done);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{role ? t.staff.editRole : t.staff.addRole}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors?.name ? null : error} />
          <Field label={t.staff.roleName} name="name" defaultValue={role?.name} error={error?.fieldErrors?.name} />
          <fieldset className="grid max-h-[50vh] gap-2 overflow-y-auto">
            <legend className="mb-1 text-sm font-medium">{t.staff.permissions}</legend>
            {PERMISSIONS.map(({ key, sensitive }) => {
              const had = role?.permissionKeys.includes(key) ?? false;
              // BR-102: a non-owner may keep or remove what the role has, but only add what they hold.
              const grantable = had || holds(me, key);
              const id = `perm-${key}`;
              return (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={keys.includes(key)}
                    disabled={!grantable}
                    onCheckedChange={(checked) =>
                      setKeys((current) => (checked === true ? [...current, key] : current.filter((k) => k !== key)))
                    }
                  />
                  <Label htmlFor={id} className="font-normal" title={grantable ? undefined : t.staff.notGrantable}>
                    {t.permissions[key]}
                  </Label>
                  {sensitive && <Badge variant="outline">{t.staff.sensitive}</Badge>}
                </div>
              );
            })}
          </fieldset>
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
