import { addMs, DAY_MS, MINUTE_MS } from "@/lib/time";
import { MAX_PASSWORD_LENGTH } from "./password/hasher";

/** SEC-02. */
export const PASSWORD_MIN_LENGTH = 8;
export { MAX_PASSWORD_LENGTH };

/** SEC-03: lock after 5 consecutive failures, for 15 minutes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * MINUTE_MS;

/** SEC-04 / T-17: 7 days, sliding with use. The sliding update is throttled to save writes. */
export const SESSION_TTL_MS = 7 * DAY_MS;
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE_MS;

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/**
 * State after one more failed attempt. On the fifth the account is locked and the counter
 * restarts, so after the lock expires the user again has five attempts.
 */
export function afterFailedAttempt(
  failedAttempts: number,
  now: Date,
): { failedAttempts: number; lockedUntil: Date | null } {
  const next = failedAttempts + 1;
  return next >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts: 0, lockedUntil: addMs(now, LOCKOUT_MS) }
    : { failedAttempts: next, lockedUntil: null };
}

/** Field error key for a new password, or null when it is acceptable (SEC-02). */
export function passwordPolicyError(password: string): "passwordTooShort" | "passwordTooLong" | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "passwordTooShort";
  if (password.length > MAX_PASSWORD_LENGTH) return "passwordTooLong";
  return null;
}
