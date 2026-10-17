import { and, count, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { auditLogs, users } from "@/db/schema";
import type { SessionUser } from "@/modules/auth/sessions";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { assertAllowed } from "@/modules/users-rbac/authorize";

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

export type AuditEntry = {
  venueId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

/**
 * Writes one audit row. Takes the operation's transaction on purpose (no plain Db):
 * if the operation fails, its audit row is rolled back with it (SEC-41).
 * Never pass passwords, hashes or tokens in before/after/meta (SEC-32).
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    venueId: entry.venueId,
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? null,
  });
}

export type AuditFilters = {
  actorId?: string;
  entityType?: AuditEntityType;
  /** Cairo calendar dates, inclusive (YYYY-MM-DD). */
  from?: string;
  to?: string;
  page?: number;
};

export const AUDIT_PAGE_SIZE = 50;

export type AuditRow = {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
};

/** S-16 (`audit.view`). Date filters are Cairo days converted in SQL (CLAUDE.md rule 9). */
export async function listAudit(
  db: DbOrTx,
  actor: SessionUser,
  filters: AuditFilters,
): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number }> {
  assertAllowed(actor, "audit.view");
  const conditions: SQL[] = [eq(auditLogs.venueId, actor.venueId)];
  if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.from) {
    conditions.push(gte(auditLogs.createdAt, sql`(${filters.from}::date)::timestamp AT TIME ZONE 'Africa/Cairo'`));
  }
  if (filters.to) {
    conditions.push(lt(auditLogs.createdAt, sql`((${filters.to}::date + 1))::timestamp AT TIME ZONE 'Africa/Cairo'`));
  }
  const where = and(...conditions);
  const page = Math.max(1, filters.page ?? 1);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        actorId: auditLogs.actorId,
        actorName: users.name,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        before: auditLogs.before,
        after: auditLogs.after,
        meta: auditLogs.meta,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);

  return { rows, total, page, pageSize: AUDIT_PAGE_SIZE };
}

/** Names for the actor filter of S-16 (`audit.view`; staff management is not required to read names). */
export async function listAuditActors(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "audit.view");
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.venueId, actor.venueId))
    .orderBy(users.name);
}
