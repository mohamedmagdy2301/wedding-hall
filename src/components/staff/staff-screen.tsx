"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/lib/i18n";
import type { RoleListItem } from "@/modules/users-rbac/roles";
import type { UserListItem } from "@/modules/users-rbac/users";
import type { CurrentUserView } from "@/server/dal";
import { RolesPanel } from "./roles-panel";
import { UsersPanel } from "./users-panel";

export type StaffMe = CurrentUserView & { id: string };

export function StaffScreen({ me, users, roles }: { me: StaffMe; users: UserListItem[]; roles: RoleListItem[] }) {
  return (
    <Tabs defaultValue="users" dir="rtl">
      <TabsList>
        <TabsTrigger value="users">{t.staff.usersTab}</TabsTrigger>
        <TabsTrigger value="roles">{t.staff.rolesTab}</TabsTrigger>
      </TabsList>
      <TabsContent value="users">
        <UsersPanel me={me} users={users} roles={roles} />
      </TabsContent>
      <TabsContent value="roles">
        <RolesPanel me={me} roles={roles} />
      </TabsContent>
    </Tabs>
  );
}
