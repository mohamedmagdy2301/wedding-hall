import { and, eq, gt, lte, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rolePermissions, sessions, userRoles, users } from "@/db/schema";
import { addMs } from "@/lib/time";
import type { DbOrTx } from "@/modules/shared/db";
import { effectivePermissions, type PermissionKey } from "@/modules/users-rbac/permissions";
import { SESSION_TOUCH_INTERVAL_MS, SESSION_TTL_MS } from "./policy";
import { generateSessionToken, hashSessionToken, looksLikeSessionToken } from "./tokens";

/** The authenticated user of a request: everything authorization needs, nothing secret. */
export type SessionUser = {
  sessionId: string;
  userId: string;
  venueId: string;
  name: string;
  login: string;
  isOwner: boolean;
  mustChangePassword: boolean;
  permissions: ReadonlySet<PermissionKey>;
  expiresAt: Date;
};

export async function createSession(db: DbOrTx, userId: string, now: Date) {
  const token = generateSessionToken();
  const expiresAt = addMs(now, SESSION_TTL_MS);
  const [row] = await db
    .insert(sessions)
    .values({ userId, tokenHash: await hashSessionToken(token), expiresAt, lastSeenAt: now, createdAt: now })
    .returning({ id: sessions.id });
  // Housekeeping: drop this user's expired sessions.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, now)));
  return { token, sessionId: row.id, expiresAt };
}

export async function loadPermissions(db: DbOrTx, userId: string, isOwner: boolean) {
  if (isOwner) return effectivePermissions(true, []);
  const rows = await db
    .selectDistinct({ key: rolePermissions.permissionKey })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  return effectivePermissions(
    false,
    rows.map((r) => r.key),
  );
}

/**
 * Checks a session token against the database on every call (P1-08): the session must
 * exist and be unexpired, and its user must still be active (BR-101). Slides the expiry
 * (T-17), writing at most once per SESSION_TOUCH_INTERVAL_MS.
 */
export async function resolveSession(db: Db, token: string | undefined, now: Date): Promise<SessionUser | null> {
  if (!looksLikeSessionToken(token)) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      venueId: users.venueId,
      name: users.name,
      login: users.login,
      isOwner: users.isOwner,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, await hashSessionToken(token)), gt(sessions.expiresAt, now), eq(users.isActive, true)),
    )
    .limit(1);
  if (!row) return null;

  let expiresAt = row.expiresAt;
  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    expiresAt = addMs(now, SESSION_TTL_MS);
    await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    venueId: row.venueId,
    name: row.name,
    login: row.login,
    isOwner: row.isOwner,
    mustChangePassword: row.mustChangePassword,
    expiresAt,
    permissions: await loadPermissions(db, row.userId, row.isOwner),
  };
}

export async function revokeSessionByToken(db: DbOrTx, token: string | undefined) {
  if (!looksLikeSessionToken(token)) return null;
  const [row] = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, await hashSessionToken(token)))
    .returning({ id: sessions.id, userId: sessions.userId });
  return row ?? null;
}

/** Ends every session of a user (deactivation, password change/reset — SEC-04, BR-101). */
export async function revokeUserSessions(db: DbOrTx, userId: string, options: { exceptSessionId?: string } = {}) {
  await db
    .delete(sessions)
    .where(
      options.exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, options.exceptSessionId))
        : eq(sessions.userId, userId),
    );
}
