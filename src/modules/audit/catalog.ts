/** Pure constants, safe to import from client components. */

/** Every audited action (P1-07). Kept as a closed list so filters and labels stay in sync. */
export const AUDIT_ACTIONS = [
  "venue.setup",
  "auth.login",
  "auth.login_failed",
  "auth.locked",
  "auth.logout",
  "auth.password_changed",
  "users.create",
  "users.update",
  "users.activate",
  "users.deactivate",
  "users.password_reset",
  "users.owner_granted",
  "users.owner_renounced",
  "support.owner_removed",
  "support.owner_password_reset",
  "roles.create",
  "roles.update",
  "roles.delete",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = ["venue", "user", "role", "session"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
