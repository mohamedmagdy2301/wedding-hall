import type { z } from "zod";
import { t } from "@/lib/i18n";
import { resolveSession, type SessionUser } from "@/modules/auth/sessions";
import type { RequestMeta, ServiceDeps } from "@/modules/shared/context";
import { AppError, type ErrorCode } from "@/modules/shared/errors";
import { satisfies, type Requirement } from "@/modules/users-rbac/authorize";

/**
 * The single pipeline of every Server Action (CLAUDE.md rule 6):
 * session → Zod → permission → service. Free of Next.js imports so integration tests
 * run the exact same code with a token instead of a cookie (SEC-11).
 */

export type ActionError = {
  code: ErrorCode;
  message: string;
  rule?: string;
  fieldErrors?: Record<string, string>;
};

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export type ActionDeps = ServiceDeps & { sessionToken: string | undefined; requestMeta: RequestMeta };

export type ActionContext = ServiceDeps & { actor: SessionUser; sessionToken: string; requestMeta: RequestMeta };

export type ProtectedOptions<S extends z.ZodType> = {
  schema: S;
  requires: Requirement;
  /** Only change-password, logout and session refresh run before a temporary password is replaced (SEC-05). */
  allowPendingPasswordChange?: boolean;
};

const messages: Record<string, string> = t.errors.messages;

const translate = (key: string) => messages[key] ?? t.errors.messages.validation;

export function failure(
  code: ErrorCode,
  key?: string,
  extra: Partial<ActionError> = {},
): { ok: false; error: ActionError } {
  return { ok: false, error: { code, message: key ? translate(key) : t.errors.codes[code], ...extra } };
}

function fromZod(error: z.ZodError) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".") || "_";
    fieldErrors[field] ??= translate(issue.message);
  }
  return failure("VALIDATION_ERROR", "validation", { fieldErrors });
}

/** Expected errors become their code; anything else is logged (message only) and reported generically. */
export function fromError(error: unknown): { ok: false; error: ActionError } {
  if (error instanceof AppError) {
    const fieldErrors = error.fieldErrors
      ? Object.fromEntries(Object.entries(error.fieldErrors).map(([k, v]) => [k, translate(v)]))
      : undefined;
    return failure(error.code, error.messageKey, { rule: error.rule, fieldErrors });
  }
  console.error("action failed:", error instanceof Error ? error.message : "unknown error");
  return failure("INTERNAL_ERROR");
}

export async function runProtected<S extends z.ZodType, R>(
  deps: ActionDeps,
  options: ProtectedOptions<S>,
  handler: (ctx: ActionContext, input: z.output<S>) => Promise<R>,
  rawInput: unknown,
): Promise<ActionResult<R>> {
  try {
    const actor = await resolveSession(deps.db, deps.sessionToken, deps.now);
    if (!actor || !deps.sessionToken) return failure("UNAUTHENTICATED", "sessionExpired");
    if (actor.mustChangePassword && !options.allowPendingPasswordChange) {
      return failure("FORBIDDEN", "passwordChangeRequired");
    }
    const parsed = options.schema.safeParse(rawInput);
    if (!parsed.success) return fromZod(parsed.error);
    if (!satisfies(actor, options.requires)) return failure("FORBIDDEN", "forbidden");

    const data = await handler({ ...deps, actor, sessionToken: deps.sessionToken }, parsed.data);
    return { ok: true, data };
  } catch (error) {
    return fromError(error);
  }
}

/** For the login form only: no session yet, so Zod → service. */
export async function runPublic<S extends z.ZodType, R>(
  deps: ActionDeps,
  schema: S,
  handler: (deps: ActionDeps, input: z.output<S>) => Promise<R>,
  rawInput: unknown,
): Promise<ActionResult<R>> {
  try {
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) return fromZod(parsed.error);
    return { ok: true, data: await handler(deps, parsed.data) };
  } catch (error) {
    return fromError(error);
  }
}
