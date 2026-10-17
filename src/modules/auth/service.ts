import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import { getVenueSummary } from "@/modules/settings/repository";
import type { RequestMeta, ServiceDeps } from "@/modules/shared/context";
import { requestMetaForAudit } from "@/modules/shared/context";
import { AppError, validationError } from "@/modules/shared/errors";
import { parseLoginId } from "./login-id";
import type { PasswordHasher } from "./password/hasher";
import { afterFailedAttempt, isLocked, passwordPolicyError } from "./policy";
import { createSession, revokeSessionByToken, revokeUserSessions, type SessionUser } from "./sessions";

/** One generic failure for every login problem, so nothing reveals whether an account exists (SEC-03). */
const loginFailed = () => new AppError("UNAUTHENTICATED", "loginFailed");

const dummyHashes = new WeakMap<PasswordHasher, string>();

/** Spends one verification on a throwaway hash so unknown logins take as long as known ones. */
function verifyDummy(hasher: PasswordHasher, password: string) {
  let dummy = dummyHashes.get(hasher);
  if (!dummy) {
    dummy = hasher.hash("dummy-password-for-timing");
    dummyHashes.set(hasher, dummy);
  }
  hasher.verify(dummy, password);
}

export type LoginInput = { login: string; password: string };
export type LoginResult = { token: string; expiresAt: Date; mustChangePassword: boolean };

/**
 * S-01 / SEC-03 / BR-101. Exactly one password verification per attempt, whatever the
 * outcome. Failed attempts are audited without the typed text unless it is a valid login
 * format, and never with the password (P1-07, SEC-32).
 */
export async function login(deps: ServiceDeps, input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
  const { db, hasher, now } = deps;
  const venue = await getVenueSummary(db);
  const loginId = parseLoginId(input.login);
  const auditMeta = { ...requestMetaForAudit(meta), login: loginId?.value ?? null };

  const user =
    venue && loginId
      ? (
          await db
            .select({
              id: users.id,
              passwordHash: users.passwordHash,
              isActive: users.isActive,
              lockedUntil: users.lockedUntil,
              mustChangePassword: users.mustChangePassword,
            })
            .from(users)
            .where(and(eq(users.venueId, venue.id), eq(users.login, loginId.value)))
            .limit(1)
        )[0]
      : undefined;

  if (!venue) {
    verifyDummy(hasher, input.password);
    throw loginFailed();
  }

  if (!user) {
    verifyDummy(hasher, input.password);
    await db.transaction((tx) =>
      recordAudit(tx, {
        venueId: venue.id,
        actorId: null,
        action: "auth.login_failed",
        entityType: "user",
        meta: { ...auditMeta, reason: loginId ? "unknown_login" : "invalid_login_format" },
      }),
    );
    throw loginFailed();
  }

  const passwordOk = hasher.verify(user.passwordHash, input.password);
  const locked = isLocked(user.lockedUntil, now);

  if (locked || !user.isActive || !passwordOk) {
    await db.transaction(async (tx) => {
      const reason = locked ? "locked" : !user.isActive ? "inactive" : "wrong_password";
      await recordAudit(tx, {
        venueId: venue.id,
        actorId: null,
        action: "auth.login_failed",
        entityType: "user",
        entityId: user.id,
        meta: { ...auditMeta, reason },
      });
      if (reason !== "wrong_password") return;

      // Row lock so concurrent wrong attempts count once each.
      const [current] = await tx
        .select({ failedAttempts: users.failedAttempts, lockedUntil: users.lockedUntil })
        .from(users)
        .where(eq(users.id, user.id))
        .for("update");
      if (isLocked(current.lockedUntil, now)) return;
      const next = afterFailedAttempt(current.failedAttempts, now);
      await tx.update(users).set(next).where(eq(users.id, user.id));
      if (next.lockedUntil) {
        await recordAudit(tx, {
          venueId: venue.id,
          actorId: null,
          action: "auth.locked",
          entityType: "user",
          entityId: user.id,
          meta: { ...auditMeta, lockedUntil: next.lockedUntil.toISOString() },
        });
      }
    });
    throw loginFailed();
  }

  // Parameters changed since this hash was made: replace it while we have the password (P1-09).
  const rehashed = hasher.needsRehash(user.passwordHash);
  const newHash = rehashed ? hasher.hash(input.password) : undefined;

  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now, ...(newHash ? { passwordHash: newHash } : {}) })
      .where(eq(users.id, user.id));
    const session = await createSession(tx, user.id, now);
    await recordAudit(tx, {
      venueId: venue.id,
      actorId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      meta: { ...auditMeta, ...(rehashed ? { passwordRehashed: true } : {}) },
    });
    return { token: session.token, expiresAt: session.expiresAt, mustChangePassword: user.mustChangePassword };
  });
}

export async function logout(deps: ServiceDeps, actor: SessionUser, token: string, meta: RequestMeta) {
  await deps.db.transaction(async (tx) => {
    await revokeSessionByToken(tx, token);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "auth.logout",
      entityType: "session",
      entityId: actor.sessionId,
      meta: requestMetaForAudit(meta),
    });
  });
}

export type ChangePasswordInput = { currentPassword: string; newPassword: string };

/**
 * S-02 / SEC-05. Ends every session of the user (SEC-04) and returns a fresh one for the
 * current browser, so the user stays signed in here and is signed out everywhere else.
 */
export async function changePassword(
  deps: ServiceDeps,
  actor: SessionUser,
  input: ChangePasswordInput,
  meta: RequestMeta,
): Promise<{ token: string; expiresAt: Date }> {
  const { db, hasher, now } = deps;
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!user || !hasher.verify(user.passwordHash, input.currentPassword)) {
    throw validationError({ currentPassword: "currentPasswordWrong" });
  }
  const policyError = passwordPolicyError(input.newPassword);
  if (policyError) throw validationError({ newPassword: policyError });
  if (input.newPassword === input.currentPassword) throw validationError({ newPassword: "passwordUnchanged" });

  const passwordHash = hasher.hash(input.newPassword);
  return db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, actor.userId));
    await revokeUserSessions(tx, actor.userId);
    const session = await createSession(tx, actor.userId, now);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "auth.password_changed",
      entityType: "user",
      entityId: actor.userId,
      meta: { ...requestMetaForAudit(meta), wasTemporary: actor.mustChangePassword },
    });
    return { token: session.token, expiresAt: session.expiresAt };
  });
}
