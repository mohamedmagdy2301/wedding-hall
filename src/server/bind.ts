import "server-only";
import type { z } from "zod";
import { runProtected, type ActionResult } from "./action-core";
import { actionDeps } from "./request";
import type { ProtectedSpec } from "./specs/define";

/** Runs a spec for the current request (cookie session, headers, real clock). */
export async function invoke<S extends z.ZodType, R>(
  spec: ProtectedSpec<S, R>,
  input: unknown,
): Promise<ActionResult<R>> {
  return runProtected(await actionDeps(), spec, spec.handler, input);
}
