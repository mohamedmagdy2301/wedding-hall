import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { DbHandle } from "@/db/client";
import { auditLogs, roles } from "@/db/schema";
import { createPasswordHasher } from "@/modules/auth/password/hasher";
import { loadArgon2ModuleFromDisk } from "@/modules/auth/password/wasm-node";
import { changePassword, login } from "@/modules/auth/service";
import { resolveSession, type SessionUser } from "@/modules/auth/sessions";
import { setupVenue } from "@/modules/settings/setup";
import type { ServiceDeps } from "@/modules/shared/context";
import { createUser } from "@/modules/users-rbac/users";
import { runProtected, type ActionResult } from "@/server/action-core";
import type { ProtectedSpec } from "@/server/specs/define";

/** Light parameters (APP_ENV=test, D-65): fast tests, same code path as production. */
export const testHasher = createPasswordHasher(loadArgon2ModuleFromDisk(), {
  memoryKib: 1024,
  iterations: 1,
  parallelism: 1,
});

export const OWNER = { login: "owner", tempPassword: "temp-owner-1", password: "owner-password-1" };
export const META = { ip: "203.0.113.7", userAgent: "vitest" };

export function depsAt(handle: DbHandle, now = new Date()): ServiceDeps {
  return { db: handle.db, hasher: testHasher, now };
}

export type Signed = { token: string; actor: SessionUser };

export async function signIn(handle: DbHandle, loginText: string, password: string, now = new Date()): Promise<Signed> {
  const { token } = await login(depsAt(handle, now), { login: loginText, password }, META);
  const actor = await resolveSession(handle.db, token, now);
  if (!actor) throw new Error("session did not resolve");
  return { token, actor };
}

/** setup-venue + the owner's first login and forced password change. */
export async function setUpVenueWithOwner(handle: DbHandle) {
  const { venueId, ownerId } = await setupVenue(depsAt(handle), {
    venueName: "قاعة الاختبار",
    ownerName: "المالك",
    ownerLogin: OWNER.login,
    ownerTempPassword: OWNER.tempPassword,
  });
  const first = await signIn(handle, OWNER.login, OWNER.tempPassword);
  await changePassword(
    depsAt(handle),
    first.actor,
    { currentPassword: OWNER.tempPassword, newPassword: OWNER.password },
    META,
  );
  const owner = await signIn(handle, OWNER.login, OWNER.password);
  const roleRows = await handle.db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.venueId, venueId));
  const roleId = (name: string) => {
    const role = roleRows.find((r) => r.name === name);
    if (!role) throw new Error(`no role ${name}`);
    return role.id;
  };
  return { venueId, ownerId, owner, roleId };
}

/** Creates a staff member and signs them in with a password they already changed. */
export async function addStaff(handle: DbHandle, by: SessionUser, loginText: string, roleIds: string[]) {
  const temp = `temp-${loginText}-1`;
  const password = `pass-${loginText}-1`;
  const { id } = await createUser(depsAt(handle), by, {
    name: `موظف ${loginText}`,
    login: loginText,
    tempPassword: temp,
    roleIds,
  });
  const first = await signIn(handle, loginText, temp);
  await changePassword(depsAt(handle), first.actor, { currentPassword: temp, newPassword: password }, META);
  const signed = await signIn(handle, loginText, password);
  return { id, password, ...signed };
}

/** Runs a spec through the real action pipeline (session → Zod → permission → service). */
export function callSpec<S extends z.ZodType, R>(
  handle: DbHandle,
  spec: ProtectedSpec<S, R>,
  token: string | undefined,
  input: unknown,
  now = new Date(),
): Promise<ActionResult<R>> {
  return runProtected({ ...depsAt(handle, now), sessionToken: token, requestMeta: META }, spec, spec.handler, input);
}

export async function auditActions(handle: DbHandle) {
  const rows = await handle.db.select({ action: auditLogs.action }).from(auditLogs);
  return rows.map((r) => r.action);
}
