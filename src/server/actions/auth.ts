"use server";

import { loginSchema } from "@/modules/auth/schemas";
import { login } from "@/modules/auth/service";
import { runPublic, type ActionResult } from "../action-core";
import { invoke } from "../bind";
import { actionDeps } from "../request";
import { clearSessionCookie, setSessionCookie } from "../session-cookie";
import { authSpecs } from "../specs/auth";

/** S-01. The token goes only into the HttpOnly cookie, never to the client code. */
export async function loginAction(input: unknown): Promise<ActionResult<{ mustChangePassword: boolean }>> {
  const result = await runPublic(await actionDeps(), loginSchema, (deps, i) => login(deps, i, deps.requestMeta), input);
  if (!result.ok) return result;
  await setSessionCookie(result.data.token, result.data.expiresAt);
  return { ok: true, data: { mustChangePassword: result.data.mustChangePassword } };
}

/** S-02. Other sessions end (SEC-04); this browser gets a new session cookie. */
export async function changePasswordAction(input: unknown): Promise<ActionResult<null>> {
  const result = await invoke(authSpecs.changePassword, input);
  if (!result.ok) return result;
  await setSessionCookie(result.data.token, result.data.expiresAt);
  return { ok: true, data: null };
}

export async function logoutAction(): Promise<ActionResult<null>> {
  const result = await invoke(authSpecs.logout, {});
  await clearSessionCookie();
  return result.ok ? { ok: true, data: null } : result;
}

/** Keeps the cookie's expiry in step with the session's sliding expiry (T-17). */
export async function refreshSessionAction(): Promise<ActionResult<null>> {
  const result = await invoke(authSpecs.refreshSession, {});
  if (!result.ok) return result;
  await setSessionCookie(result.data.token, result.data.expiresAt);
  return { ok: true, data: null };
}
