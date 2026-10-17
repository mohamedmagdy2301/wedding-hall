"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { userSpecs } from "../specs/users";

/** S-15. Each action runs session → Zod → permission → service on the server (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  if (awaited.ok) revalidatePath("/staff");
  return awaited;
}

export async function createUserAction(input: unknown) {
  return run(invoke(userSpecs.createUser, input));
}
export async function updateUserAction(input: unknown) {
  return run(invoke(userSpecs.updateUser, input));
}
export async function setUserActiveAction(input: unknown) {
  return run(invoke(userSpecs.setUserActive, input));
}
export async function resetUserPasswordAction(input: unknown) {
  return run(invoke(userSpecs.resetUserPassword, input));
}
export async function grantOwnershipAction(input: unknown) {
  return run(invoke(userSpecs.grantOwnership, input));
}
export async function renounceOwnershipAction() {
  return run(invoke(userSpecs.renounceOwnership, {}));
}
export async function createRoleAction(input: unknown) {
  return run(invoke(userSpecs.createRole, input));
}
export async function updateRoleAction(input: unknown) {
  return run(invoke(userSpecs.updateRole, input));
}
export async function deleteRoleAction(input: unknown) {
  return run(invoke(userSpecs.deleteRole, input));
}
