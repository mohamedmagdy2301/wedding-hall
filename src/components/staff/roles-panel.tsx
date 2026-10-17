"use client";

import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import { PERMISSIONS } from "@/modules/users-rbac/permissions";
import type { RoleListItem } from "@/modules/users-rbac/roles";
import { deleteRoleAction } from "@/server/actions/users";
import { RoleDialog } from "./role-dialog";
import type { StaffMe } from "./staff-screen";

type Dialogs = { kind: "create" } | { kind: "edit" | "delete"; role: RoleListItem } | null;

/** Roles and the permission matrix (S-15). The owner holds every permission without a role. */
export function RolesPanel({ me, roles }: { me: StaffMe; roles: RoleListItem[] }) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const remove = useServerAction(deleteRoleAction);
  const close = () => setDialog(null);

  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {t.staff.addRole}
        </Button>
      </div>

      <h2 className="sr-only">{t.staff.permissionMatrix}</h2>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-56">{t.staff.permissions}</TableHead>
              {roles.map((role) => (
                <TableHead key={role.id} className="text-center align-top">
                  <div className="grid justify-items-center gap-1 py-1">
                    <span>{role.name}</span>
                    {role.isSystem && <Badge variant="outline">{t.staff.systemRole}</Badge>}
                    <span className="text-xs font-normal text-muted-foreground">
                      {t.staff.usersCount}: {role.userCount}
                    </span>
                    <div className="flex gap-1">
                      <Button size="xs" variant="outline" onClick={() => setDialog({ kind: "edit", role })}>
                        {t.staff.edit}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={role.userCount > 0}
                        onClick={() => setDialog({ kind: "delete", role })}
                      >
                        {t.staff.deleteRole}
                      </Button>
                    </div>
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {PERMISSIONS.map(({ key, sensitive }) => (
              <TableRow key={key}>
                <TableCell>
                  <span>{t.permissions[key]}</span>
                  {sensitive && (
                    <Badge variant="outline" className="ms-2">
                      {t.staff.sensitive}
                    </Badge>
                  )}
                </TableCell>
                {roles.map((role) => (
                  <TableCell key={role.id} className="text-center">
                    {role.permissionKeys.includes(key) ? (
                      <Check className="mx-auto size-4 text-success" aria-label={t.common.yes} />
                    ) : (
                      <span className="text-muted-foreground" aria-label={t.common.no}>
                        {t.common.none}
                      </span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <RoleDialog
          key={dialog.kind === "edit" ? dialog.role.id : "new"}
          me={me}
          role={dialog.kind === "edit" ? dialog.role : undefined}
          open
          onOpenChange={(open) => !open && close()}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={`${t.staff.deleteRole} — ${dialog.role.name}`}
          description={t.staff.deleteRoleConfirm}
          confirmLabel={t.staff.deleteRole}
          destructive
          pending={remove.pending}
          error={remove.error}
          onConfirm={() => remove.run({ roleId: dialog.role.id }, close)}
        />
      )}
    </div>
  );
}
