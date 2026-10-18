/**
 * Error codes returned to the UI (API.md). Services throw AppError; the action wrapper
 * turns it into `{ ok: false, error }` with the Arabic message for the code/key.
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT_SLOT_TAKEN",
  "CONCURRENT_MODIFICATION",
  "BUSINESS_RULE_VIOLATION",
  // The re-priced total differs from the one the staff member confirmed (D-124).
  "PRICE_CHANGED",
  // Transient: the database kept aborting the transaction for timing reasons (D-113).
  "RETRY_LATER",
  // Not in API.md's list: an unexpected failure the user can only retry.
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** Key under `errors.messages` in the i18n catalog. */
    readonly messageKey: string,
    readonly options: { rule?: string; fieldErrors?: FieldErrors; details?: Record<string, unknown> } = {},
  ) {
    super(`${code}: ${messageKey}${options.rule ? ` (${options.rule})` : ""}`);
    this.name = "AppError";
  }

  get rule() {
    return this.options.rule;
  }

  get fieldErrors() {
    return this.options.fieldErrors;
  }

  /** Data the screen needs to act on the error, e.g. the new price (D-124). */
  get details() {
    return this.options.details;
  }
}

/** A business rule from BUSINESS_RULES.md was violated. */
export const ruleViolation = (rule: string, messageKey: string) =>
  new AppError("BUSINESS_RULE_VIOLATION", messageKey, { rule });

export const forbidden = (messageKey = "forbidden", rule?: string) => new AppError("FORBIDDEN", messageKey, { rule });

export const notFound = (messageKey = "notFound") => new AppError("NOT_FOUND", messageKey);

export const validationError = (fieldErrors: FieldErrors, messageKey = "validation") =>
  new AppError("VALIDATION_ERROR", messageKey, { fieldErrors });

/** SQLSTATE and constraint name of a PostgreSQL error, through driver/Drizzle wrapping. */
export function pgError(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

export const isUniqueViolation = (error: unknown, constraint: string) => {
  const e = pgError(error);
  return e.code === "23505" && e.constraint === constraint;
};
