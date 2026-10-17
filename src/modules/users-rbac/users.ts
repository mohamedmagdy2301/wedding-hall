import { and, asc, eq, inArray } from "drizzle-orm";
import { rolePermissions, roles, userRoles, users } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import { parseLoginId } from "@/modules/auth/login-id";
import { passwordPolicyError } from "@/modules/auth/policy";
import { revokeUserSessions, type SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import {
  AppError,
  forbidden,
  isUniqueViolation,
  notFound,
  ruleViolation,
  validationError,
} from "@/modules/shared/errors";
import { assertAllowed } from "./authorize";
import { isPermissionKey, ungrantableKeys } from "./permissions";

export type UserListItem = {
  id: string;
  name: string;
  login: string;
  isOwner: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  roleIds: string[];
};

/** Audit snapshot of a user: never the password hash (SEC-32). */
async function userSnapshot(db: DbOrTx, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      login: users.login,
      isOwner: users.isOwner,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const roleRows = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
  return { ...user, roleIds: roleRows.map((r) => r.roleId).sort() };
}

async function getTarget(db: DbOrTx, actor: SessionUser, userId: string) {
  const snapshot = await userSnapshot(db, userId);
  const [row] = snapshot ? await db.select({ venueId: users.venueId }).from(users).where(eq(users.id, userId)) : [];
  if (!snapshot || row?.venueId !== actor.venueId) throw notFound("userNotFound");
  return snapshot;
}

/** BR-102: a non-owner never edits an owner's account. */
function assertCanManage(actor: SessionUser, target: { isOwner: boolean }) {
  if (target.isOwner && !actor.isOwner) throw forbidden("ownerAccountProtected", "BR-102");
}

function normalizeLogin(login: string) {
  const id = parseLoginId(login);
  if (!id) throw validationError({ login: "loginInvalid" });
  return id.value;
}

function assertTempPassword(password: string) {
  const error = passwordPolicyError(password);
  if (error) throw validationError({ tempPassword: error });
}

/**
 * Validates role ids and BR-102: roles being newly given must not carry a permission the
 * granting non-owner lacks. Roles the user already had are not re-checked (removing is not granting).
 */
async function assertRolesGrantable(tx: Tx, actor: SessionUser, roleIds: string[], alreadyHeld: string[] = []) {
  const unique = [...new Set(roleIds)];
  if (unique.length === 0) return unique;
  const found = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.venueId, actor.venueId), inArray(roles.id, unique)));
  if (found.length !== unique.length) throw validationError({ roleIds: "roleNotFound" });

  const added = unique.filter((id) => !alreadyHeld.includes(id));
  if (!actor.isOwner && added.length > 0) {
    const keys = await tx
      .selectDistinct({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, added));
    const missing = ungrantableKeys(actor.permissions, keys.map((k) => k.key).filter(isPermissionKey));
    if (missing.length > 0) throw forbidden("cannotGrantPermissions", "BR-102");
  }
  return unique;
}

async function replaceRoles(tx: Tx, userId: string, roleIds: string[]) {
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  if (roleIds.length > 0) await tx.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId })));
}

function mapLoginConflict(error: unknown): never {
  if (isUniqueViolation(error, "users_venue_login_unique")) throw validationError({ login: "loginTaken" });
  throw error;
}

export async function listUsers(db: DbOrTx, actor: SessionUser): Promise<UserListItem[]> {
  assertAllowed(actor, "users.manage");
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      login: users.login,
      isOwner: users.isOwner,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.venueId, actor.venueId))
    .orderBy(asc(users.createdAt));
  const assignments = rows.length
    ? await db
        .select({ userId: userRoles.userId, roleId: userRoles.roleId })
        .from(userRoles)
        .where(
          inArray(
            userRoles.userId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => ({ ...r, roleIds: assignments.filter((a) => a.userId === r.id).map((a) => a.roleId) }));
}

export type CreateUserInput = { name: string; login: string; tempPassword: string; roleIds: string[] };

/** UF-11. The temporary password must be changed at first login (SEC-05, D-45). */
export async function createUser(deps: ServiceDeps, actor: SessionUser, input: CreateUserInput) {
  assertAllowed(actor, "users.manage");
  const login = normalizeLogin(input.login);
  assertTempPassword(input.tempPassword);
  const passwordHash = deps.hasher.hash(input.tempPassword);

  return deps.db
    .transaction(async (tx) => {
      const roleIds = await assertRolesGrantable(tx, actor, input.roleIds);
      const [user] = await tx
        .insert(users)
        .values({ venueId: actor.venueId, name: input.name.trim(), login, passwordHash, mustChangePassword: true })
        .returning({ id: users.id });
      await replaceRoles(tx, user.id, roleIds);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "users.create",
        entityType: "user",
        entityId: user.id,
        after: await userSnapshot(tx, user.id),
      });
      return { id: user.id };
    })
    .catch(mapLoginConflict);
}

export type UpdateUserInput = { userId: string; name: string; login: string; roleIds: string[] };

export async function updateUser(deps: ServiceDeps, actor: SessionUser, input: UpdateUserInput) {
  assertAllowed(actor, "users.manage");
  const login = normalizeLogin(input.login);

  await deps.db
    .transaction(async (tx) => {
      const before = await getTarget(tx, actor, input.userId);
      assertCanManage(actor, before);
      // P1-11: nobody changes another owner's login; each owner changes their own.
      if (before.isOwner && before.id !== actor.userId && login !== before.login) {
        throw ruleViolation("BR-100", "ownerLoginProtected");
      }
      const roleIds = await assertRolesGrantable(tx, actor, input.roleIds, before.roleIds);
      await tx.update(users).set({ name: input.name.trim(), login }).where(eq(users.id, input.userId));
      await replaceRoles(tx, input.userId, roleIds);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "users.update",
        entityType: "user",
        entityId: input.userId,
        before,
        after: await userSnapshot(tx, input.userId),
      });
    })
    .catch(mapLoginConflict);
}

/** BR-100: an owner can never be deactivated in the app. BR-101: deactivation ends the user's sessions. */
export async function setUserActive(deps: ServiceDeps, actor: SessionUser, input: { userId: string; active: boolean }) {
  assertAllowed(actor, "users.manage");
  await deps.db.transaction(async (tx) => {
    const before = await getTarget(tx, actor, input.userId);
    assertCanManage(actor, before);
    if (before.isOwner && !input.active) throw ruleViolation("BR-100", "ownerCannotBeDeactivated");
    if (before.isActive === input.active) return;

    await tx.update(users).set({ isActive: input.active }).where(eq(users.id, input.userId));
    if (!input.active) await revokeUserSessions(tx, input.userId);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: input.active ? "users.activate" : "users.deactivate",
      entityType: "user",
      entityId: input.userId,
      before,
      after: await userSnapshot(tx, input.userId),
    });
  });
}

/**
 * UF-11. Owners' passwords are never reset in the app (P1-11): an owner changes their own,
 * and a forgotten one is reset by the support script.
 */
export async function resetUserPassword(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { userId: string; tempPassword: string },
) {
  assertAllowed(actor, "users.manage");
  assertTempPassword(input.tempPassword);
  const passwordHash = deps.hasher.hash(input.tempPassword);

  await deps.db.transaction(async (tx) => {
    const before = await getTarget(tx, actor, input.userId);
    assertCanManage(actor, before);
    if (before.isOwner) throw ruleViolation("BR-100", "ownerPasswordProtected");

    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, input.userId));
    await revokeUserSessions(tx, input.userId);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "users.password_reset",
      entityType: "user",
      entityId: input.userId,
    });
  });
}

/** Locks the active owners' rows so concurrent ownership changes cannot leave zero owners (BR-100). */
export async function lockActiveOwners(tx: Tx, venueId: string) {
  return tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.venueId, venueId), eq(users.isOwner, true), eq(users.isActive, true)))
    .for("update");
}

/** P1-11: an owner makes another active user an owner. */
export async function grantOwnership(deps: ServiceDeps, actor: SessionUser, input: { userId: string }) {
  assertAllowed(actor, "owner");
  await deps.db.transaction(async (tx) => {
    const before = await getTarget(tx, actor, input.userId);
    if (before.isOwner) return;
    if (!before.isActive) throw new AppError("BUSINESS_RULE_VIOLATION", "inactiveCannotBeOwner", { rule: "BR-100" });
    await tx.update(users).set({ isOwner: true }).where(eq(users.id, input.userId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "users.owner_granted",
      entityType: "user",
      entityId: input.userId,
      before,
      after: await userSnapshot(tx, input.userId),
    });
  });
}

/** P1-11: an owner gives up their own ownership, only while another active owner remains. */
export async function renounceOwnership(deps: ServiceDeps, actor: SessionUser) {
  assertAllowed(actor, "owner");
  await deps.db.transaction(async (tx) => {
    const owners = await lockActiveOwners(tx, actor.venueId);
    if (!owners.some((o) => o.id !== actor.userId)) throw ruleViolation("BR-100", "lastOwner");
    const before = await userSnapshot(tx, actor.userId);
    await tx.update(users).set({ isOwner: false }).where(eq(users.id, actor.userId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "users.owner_renounced",
      entityType: "user",
      entityId: actor.userId,
      before,
      after: await userSnapshot(tx, actor.userId),
    });
  });
}
