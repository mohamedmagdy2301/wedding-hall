import type { Db } from "@/db/client";
import type { PasswordHasher } from "@/modules/auth/password/hasher";

/**
 * What every service call gets from its caller (the action wrapper, a script or a test):
 * the connection, the password hasher, and the clock — injected so lockout and session
 * expiry can be tested without waiting.
 */
export type ServiceDeps = {
  db: Db;
  hasher: PasswordHasher;
  now: Date;
};

/** Client details recorded with login events (P1-07). */
export type RequestMeta = {
  ip?: string | null;
  userAgent?: string | null;
};

export function requestMetaForAudit(meta: RequestMeta) {
  return { ip: meta.ip ?? null, userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null };
}
