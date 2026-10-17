import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/db/request";
import { listAudit, listAuditActors, type AuditFilters } from "@/modules/audit/service";
import { resolveSession, type SessionUser } from "@/modules/auth/sessions";
import { getSetupChecklist } from "@/modules/settings/checklist";
import { listItems } from "@/modules/settings/lists";
import { getVenueSummary } from "@/modules/settings/repository";
import type { ListKind } from "@/modules/settings/schemas";
import { listSeasons } from "@/modules/settings/seasons";
import { getTiming, getVenueSettings } from "@/modules/settings/venue";
import { listSpaces } from "@/modules/spaces/service";
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
  // Per-request data: never prerendered at build time.
  await connection();
  const token = await readSessionToken();
  return resolveSession(getDb(), token, new Date());
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

/** For screens open to any of several permissions (the settings shell). */
export async function requireAnyAccess(requirements: Requirement[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!requirements.some((r) => satisfies(user, r))) redirect("/forbidden");
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

/** S-13 tabs. Each checks its own permission (D-66: spaces and seasons are `catalog.manage`). */
export async function getVenueSettingsPageData() {
  const actor = await requireAccess("settings.manage");
  return getVenueSettings(getDb(), actor);
}

export async function getSpacesPageData() {
  const actor = await requireAccess("catalog.manage");
  const db = getDb();
  const [spaces, timing] = await Promise.all([listSpaces(db, actor), getTiming(db, actor.venueId)]);
  return { spaces, bufferMinutes: timing.bufferMinutes };
}

export async function getSeasonsPageData() {
  const actor = await requireAccess("catalog.manage");
  return { seasons: await listSeasons(getDb(), actor) };
}

export async function getListPageData(kind: ListKind) {
  const actor = await requireAccess("settings.manage");
  return { items: await listItems(getDb(), actor, kind) };
}

/** S-14 (owner). */
export async function getSetupPageData() {
  const actor = await requireAccess("owner");
  const db = getDb();
  const [checklist, timing] = await Promise.all([getSetupChecklist(db, actor), getTiming(db, actor.venueId)]);
  return { ...checklist, timing };
}

/** The home card: shown to owners while the guided setup is incomplete (S-14). */
export async function getHomeSetupCard() {
  const actor = await requireUser();
  if (!actor.isOwner) return null;
  const { steps, complete } = await getSetupChecklist(getDb(), actor);
  if (complete) return null;
  const counted = steps.filter((s) => s.required);
  return { done: counted.filter((s) => s.status === "done").length, total: counted.length };
}
