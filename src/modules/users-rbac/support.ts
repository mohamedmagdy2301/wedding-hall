import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import { parseLoginId } from "@/modules/auth/login-id";
import { passwordPolicyError } from "@/modules/auth/policy";
import { revokeUserSessions } from "@/modules/auth/sessions";
import { getVenueSummary } from "@/modules/settings/repository";
import type { ServiceDeps } from "@/modules/shared/context";
import type { Tx } from "@/modules/shared/db";
import { AppError, notFound, ruleViolation, validationError } from "@/modules/shared/errors";
import { lockActiveOwners } from "./users";

/**
 * Support operations run by the product owner from scripts/ (P1-11) — the only way to
 * remove another owner or reset an owner's forgotten password. Audited with no actor.
 */

async function findOwnerByLogin(tx: Tx, login: string) {
  const venue = await getVenueSummary(tx);
  if (!venue) throw notFound("venueNotSetUp");
  const id = parseLoginId(login);
  if (!id) throw validationError({ login: "loginInvalid" });
  const [user] = await tx
    .select({ id: users.id, name: users.name, login: users.login, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.venueId, venue.id), eq(users.login, id.value)));
  if (!user) throw notFound("userNotFound");
  if (!user.isOwner) throw new AppError("BUSINESS_RULE_VIOLATION", "notAnOwner");
  return { venueId: venue.id, user };
}

const supportMeta = (script: string) => ({ source: "support-script", script });

/** Removes ownership from an owner, as long as another active owner remains (BR-100). */
export async function removeOwner(deps: ServiceDeps, input: { login: string }) {
  return deps.db.transaction(async (tx) => {
    const { venueId, user } = await findOwnerByLogin(tx, input.login);
    const owners = await lockActiveOwners(tx, venueId);
    if (!owners.some((o) => o.id !== user.id)) throw ruleViolation("BR-100", "lastOwner");

    await tx.update(users).set({ isOwner: false }).where(eq(users.id, user.id));
    await recordAudit(tx, {
      venueId,
      actorId: null,
      action: "support.owner_removed",
      entityType: "user",
      entityId: user.id,
      before: { ...user },
      after: { ...user, isOwner: false },
      meta: supportMeta("remove-owner"),
    });
    return { userId: user.id, name: user.name };
  });
}

/** Sets a temporary password for an owner who forgot theirs; it must be changed at first login. */
export async function resetOwnerPassword(deps: ServiceDeps, input: { login: string; tempPassword: string }) {
  const policyError = passwordPolicyError(input.tempPassword);
  if (policyError) throw validationError({ tempPassword: policyError });
  const passwordHash = deps.hasher.hash(input.tempPassword);

  return deps.db.transaction(async (tx) => {
    const { venueId, user } = await findOwnerByLogin(tx, input.login);
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id);
    await recordAudit(tx, {
      venueId,
      actorId: null,
      action: "support.owner_password_reset",
      entityType: "user",
      entityId: user.id,
      meta: supportMeta("reset-owner-password"),
    });
    return { userId: user.id, name: user.name };
  });
}
