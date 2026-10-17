import type { SessionUser } from "@/modules/auth/sessions";
import { forbidden } from "@/modules/shared/errors";
import type { PermissionKey } from "./permissions";

/** Requirement of a protected operation, checked on the server for every call (SEC-10). */
export type Requirement = PermissionKey | "owner" | "authenticated";

export function satisfies(actor: SessionUser, requirement: Requirement): boolean {
  if (requirement === "authenticated") return true;
  if (requirement === "owner") return actor.isOwner;
  return actor.isOwner || actor.permissions.has(requirement);
}

export function assertAllowed(actor: SessionUser, requirement: Requirement): void {
  if (!satisfies(actor, requirement)) throw forbidden();
}
