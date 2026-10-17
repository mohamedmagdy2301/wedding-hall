import type { z } from "zod";
import type { ActionContext, ProtectedOptions } from "../action-core";

/**
 * A protected operation: input schema, requirement and service call. Kept free of Next.js
 * so the same definitions are bound to Server Actions (src/server/actions) and exercised
 * directly by the SEC-11 integration tests.
 */
export type ProtectedSpec<S extends z.ZodType, R> = ProtectedOptions<S> & {
  handler: (ctx: ActionContext, input: z.output<S>) => Promise<R>;
};

export const defineProtected = <S extends z.ZodType, R>(spec: ProtectedSpec<S, R>) => spec;
