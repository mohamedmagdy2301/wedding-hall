import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/request";
import { listAudit, listAuditActors, type AuditFilters } from "@/modules/audit/service";
import { resolveSession, type SessionUser } from "@/modules/auth/sessions";
import { getVenueSummary } from "@/modules/settings/repository";
import { satisfies, type Requirement } from "@/modules/users-rbac/authorize";
import { listRoles } from "@/modules/users-rbac/roles";
import { listUsers } from "@/modules/users-rbac/users";
import { readSessionToken } from "./session-cookie";

/**
 * Data access layer (P1-08). Every page and every data function below checks the session
 * against the database itself; layouts only add an early redirect, because they do not
 * re-run on client navigation. `cache` dedupes the check within one render.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  return resolveSession(getDb(), await readSessionToken(), new Date());
});

export async function requireUser(options: { allowPendingPasswordChange?: boolean } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !options.allowPendingPasswordChange) redirect("/change-password");
  return user;
}

export async function requireAccess(requirement: Requirement): Promise<SessionUser> {
  const user = await requireUser();
  if (!satisfies(user, requirement)) redirect("/forbidden");
  return user;
}

/** What the client may know about the current user (DTO: no session id, no secrets). */
export type CurrentUserView = {
  name: string;
  login: string;
  isOwner: boolean;
  permissions: string[];
};

export function toView(user: SessionUser): CurrentUserView {
  return { name: user.name, login: user.login, isOwner: user.isOwner, permissions: [...user.permissions] };
}

export async function getShellData() {
  const user = await requireUser();
  const venue = await getVenueSummary(getDb());
  return { user: toView(user), venueName: venue?.name ?? "" };
}

export async function getStaffPageData() {
  const actor = await requireAccess("users.manage");
  const db = getDb();
  const [users, roles] = await Promise.all([listUsers(db, actor), listRoles(db, actor)]);
  return { me: { ...toView(actor), id: actor.userId }, users, roles };
}

export async function getAuditPageData(filters: AuditFilters) {
  const actor = await requireAccess("audit.view");
  const db = getDb();
  const [result, actors] = await Promise.all([listAudit(db, actor, filters), listAuditActors(db, actor)]);
  return { ...result, actors };
}
