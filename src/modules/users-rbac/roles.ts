import { and, asc, count, eq, inArray } from "drizzle-orm";
import { rolePermissions, roles, userRoles } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, forbidden, isUniqueViolation, notFound, validationError } from "@/modules/shared/errors";
import { assertAllowed } from "./authorize";
import { isPermissionKey, ungrantableKeys, type PermissionKey } from "./permissions";

export type RoleListItem = {
  id: string;
  name: string;
  isSystem: boolean;
  permissionKeys: PermissionKey[];
  userCount: number;
};

async function roleSnapshot(db: DbOrTx, roleId: string) {
  const [role] = await db
    .select({ id: roles.id, venueId: roles.venueId, name: roles.name })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!role) return null;
  const keys = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return { ...role, permissionKeys: keys.map((k) => k.key).sort() };
}

async function getRole(db: DbOrTx, actor: SessionUser, roleId: string) {
  const role = await roleSnapshot(db, roleId);
  if (!role || role.venueId !== actor.venueId) throw notFound("roleNotFound");
  return { id: role.id, name: role.name, permissionKeys: role.permissionKeys };
}

function validKeys(keys: string[]): PermissionKey[] {
  const unique = [...new Set(keys)];
  if (!unique.every(isPermissionKey)) throw validationError({ permissionKeys: "permissionUnknown" });
  return unique;
}

/** BR-102: a non-owner may only add permissions they hold themselves. */
function assertKeysGrantable(actor: SessionUser, added: PermissionKey[]) {
  if (!actor.isOwner && ungrantableKeys(actor.permissions, added).length > 0) {
    throw forbidden("cannotGrantPermissions", "BR-102");
  }
}

async function setKeys(tx: Tx, roleId: string, keys: PermissionKey[]) {
  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (keys.length > 0) {
    await tx.insert(rolePermissions).values(keys.map((permissionKey) => ({ roleId, permissionKey })));
  }
}

function mapNameConflict(error: unknown): never {
  if (isUniqueViolation(error, "roles_venue_name_unique")) throw validationError({ name: "roleNameTaken" });
  throw error;
}

export async function listRoles(db: DbOrTx, actor: SessionUser): Promise<RoleListItem[]> {
  assertAllowed(actor, "users.manage");
  const rows = await db
    .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.venueId, actor.venueId))
    .orderBy(asc(roles.createdAt), asc(roles.name));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [keys, counts] = await Promise.all([
    db
      .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, ids)),
    db
      .select({ roleId: userRoles.roleId, n: count() })
      .from(userRoles)
      .where(inArray(userRoles.roleId, ids))
      .groupBy(userRoles.roleId),
  ]);
  return rows.map((r) => ({
    ...r,
    permissionKeys: keys
      .filter((k) => k.roleId === r.id)
      .map((k) => k.key)
      .filter(isPermissionKey),
    userCount: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

export type RoleInput = { name: string; permissionKeys: string[] };

export async function createRole(deps: ServiceDeps, actor: SessionUser, input: RoleInput) {
  assertAllowed(actor, "users.manage");
  const keys = validKeys(input.permissionKeys);
  assertKeysGrantable(actor, keys);
  return deps.db
    .transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ venueId: actor.venueId, name: input.name.trim() })
        .returning({ id: roles.id });
      await setKeys(tx, role.id, keys);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "roles.create",
        entityType: "role",
        entityId: role.id,
        after: await getRole(tx, actor, role.id),
      });
      return { id: role.id };
    })
    .catch(mapNameConflict);
}

/** Default roles are editable like any other (P1-06). */
export async function updateRole(deps: ServiceDeps, actor: SessionUser, input: RoleInput & { roleId: string }) {
  assertAllowed(actor, "users.manage");
  const keys = validKeys(input.permissionKeys);
  await deps.db
    .transaction(async (tx) => {
      const before = await getRole(tx, actor, input.roleId);
      assertKeysGrantable(
        actor,
        keys.filter((k) => !before.permissionKeys.includes(k)),
      );
      await tx.update(roles).set({ name: input.name.trim() }).where(eq(roles.id, input.roleId));
      await setKeys(tx, input.roleId, keys);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "roles.update",
        entityType: "role",
        entityId: input.roleId,
        before,
        after: await getRole(tx, actor, input.roleId),
      });
    })
    .catch(mapNameConflict);
}

/** A role can be deleted only while no user has it (P1-06, API.md). */
export async function deleteRole(deps: ServiceDeps, actor: SessionUser, input: { roleId: string }) {
  assertAllowed(actor, "users.manage");
  await deps.db.transaction(async (tx) => {
    const before = await getRole(tx, actor, input.roleId);
    const [{ n }] = await tx.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, input.roleId));
    if (n > 0) throw new AppError("BUSINESS_RULE_VIOLATION", "roleInUse");
    // Removing grants is not restricted for non-owners; deleting an unused role removes none.
    await tx.delete(roles).where(and(eq(roles.id, input.roleId), eq(roles.venueId, actor.venueId)));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "roles.delete",
      entityType: "role",
      entityId: input.roleId,
      before,
    });
  });
}
