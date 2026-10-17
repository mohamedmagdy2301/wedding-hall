import type { RoleListItem } from "@/modules/users-rbac/roles";
import type { StaffMe } from "./staff-screen";

/**
 * UI mirror of BR-102 so non-owners are not offered what the server would refuse.
 * Convenience only: the server checks every call (SEC-10).
 */
export const holds = (me: StaffMe, key: string) => me.isOwner || me.permissions.includes(key);

export const canGrantRole = (me: StaffMe, role: RoleListItem) => role.permissionKeys.every((k) => holds(me, k));
