import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { venues } from "./venues";

// DATA_MODEL §7.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    name: text("name").notNull(),
    // Normalized mobile (01XXXXXXXXX, D-52) or lower-case username (P1-04).
    login: text("login").notNull(),
    // Argon2id PHC string; never leaves the auth module (SEC-32).
    passwordHash: text("password_hash").notNull(),
    isOwner: boolean("is_owner").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("users_venue_login_unique").on(t.venueId, t.login),
    check("users_failed_attempts_check", sql`${t.failedAttempts} >= 0`),
    check("users_login_normalized_check", sql`${t.login} = lower(${t.login}) AND length(${t.login}) BETWEEN 3 AND 32`),
  ],
);

/** Only the SHA-256 of the session token is stored (D-61). No venue_id: follows its user (D-63). */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique("sessions_token_hash_unique"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    name: text("name").notNull(),
    // Marks the default roles created by setup-venue; they stay editable (P1-06).
    isSystem: boolean("is_system").notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("roles_venue_name_unique").on(t.venueId, t.name)],
);

/** Keys come from the fixed list in code (ROLES_PERMISSIONS.md). No venue_id (D-63). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

/** A role in use cannot be deleted (P1-06): the foreign key restricts it. No venue_id (D-63). */
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index("user_roles_role_id_idx").on(t.roleId)],
);
