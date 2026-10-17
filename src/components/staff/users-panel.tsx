"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import { formatCairoDateTime } from "@/lib/time";
import type { RoleListItem } from "@/modules/users-rbac/roles";
import type { UserListItem } from "@/modules/users-rbac/users";
import { grantOwnershipAction, renounceOwnershipAction, setUserActiveAction } from "@/server/actions/users";
import { ResetPasswordDialog } from "./reset-password-dialog";
import type { StaffMe } from "./staff-screen";
import { UserDialog } from "./user-dialog";

type Dialogs =
  | { kind: "create" }
  | { kind: "edit" | "reset" | "toggleActive" | "grantOwner"; user: UserListItem }
  | { kind: "renounce" }
  | null;

export function UsersPanel({ me, users, roles }: { me: StaffMe; users: UserListItem[]; roles: RoleListItem[] }) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const setActive = useServerAction(setUserActiveAction);
  const grant = useServerAction(grantOwnershipAction);
  const renounce = useServerAction(renounceOwnershipAction);
  const close = () => setDialog(null);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "";
  const otherActiveOwner = users.some((u) => u.isOwner && u.isActive && u.id !== me.id);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {t.staff.addUser}
        </Button>
        {me.isOwner && otherActiveOwner && (
          <Button variant="outline" onClick={() => setDialog({ kind: "renounce" })}>
            {t.staff.renounceOwnership}
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.staff.name}</TableHead>
              <TableHead>{t.staff.login}</TableHead>
              <TableHead>{t.staff.roles}</TableHead>
              <TableHead>{t.staff.status}</TableHead>
              <TableHead>{t.staff.lastLogin}</TableHead>
              <TableHead>
                <span className="sr-only">{t.common.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              // BR-102 / P1-11, mirrored for convenience: the server enforces them.
              const canEdit = !user.isOwner || me.isOwner;
              const canTouchAccount = !user.isOwner;
              return (
                <TableRow key={user.id} data-testid={`user-row-${user.login}`}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell dir="ltr" className="text-end">
                    {user.login}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.isOwner && <Badge>{t.staff.owner}</Badge>}
                      {user.roleIds.map((id) => (
                        <Badge key={id} variant="secondary">
                          {roleName(id)}
                        </Badge>
                      ))}
                      {!user.isOwner && user.roleIds.length === 0 && (
                        <span className="text-muted-foreground">{t.staff.noRoles}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={user.isActive ? "outline" : "destructive"}>
                        {user.isActive ? t.staff.active : t.staff.inactive}
                      </Badge>
                      {user.locked && <Badge variant="destructive">{t.staff.locked}</Badge>}
                      {user.mustChangePassword && <Badge variant="outline">{t.staff.mustChange}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {user.lastLoginAt ? formatCairoDateTime(user.lastLoginAt) : t.staff.neverLoggedIn}
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${user.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", user })}>
                            {t.staff.edit}
                          </DropdownMenuItem>
                          {canTouchAccount && (
                            <>
                              <DropdownMenuItem onSelect={() => setDialog({ kind: "reset", user })}>
                                {t.staff.resetPassword}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setDialog({ kind: "toggleActive", user })}>
                                {user.isActive ? t.staff.deactivate : t.staff.activate}
                              </DropdownMenuItem>
                            </>
                          )}
                          {me.isOwner && !user.isOwner && user.isActive && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => setDialog({ kind: "grantOwner", user })}>
                                {t.staff.grantOwnership}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <UserDialog
          key={dialog.kind === "edit" ? dialog.user.id : "new"}
          me={me}
          roles={roles}
          user={dialog.kind === "edit" ? dialog.user : undefined}
          open
          onOpenChange={(open) => !open && close()}
        />
      )}
      {dialog?.kind === "reset" && (
        <ResetPasswordDialog user={dialog.user} open onOpenChange={(open) => !open && close()} />
      )}
      {dialog?.kind === "toggleActive" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={`${dialog.user.isActive ? t.staff.deactivate : t.staff.activate} — ${dialog.user.name}`}
          description={dialog.user.isActive ? t.staff.deactivateConfirm : ""}
          confirmLabel={dialog.user.isActive ? t.staff.deactivate : t.staff.activate}
          destructive={dialog.user.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() => setActive.run({ userId: dialog.user.id, active: !dialog.user.isActive }, close)}
        />
      )}
      {dialog?.kind === "grantOwner" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={`${t.staff.grantOwnership} — ${dialog.user.name}`}
          description={t.staff.grantOwnershipConfirm}
          confirmLabel={t.staff.grantOwnership}
          pending={grant.pending}
          error={grant.error}
          onConfirm={() => grant.run({ userId: dialog.user.id }, close)}
        />
      )}
      {dialog?.kind === "renounce" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t.staff.renounceOwnership}
          description={t.staff.renounceOwnershipConfirm}
          confirmLabel={t.staff.renounceOwnership}
          destructive
          pending={renounce.pending}
          error={renounce.error}
          onConfirm={() => renounce.run(undefined, close)}
        />
      )}
    </div>
  );
}
