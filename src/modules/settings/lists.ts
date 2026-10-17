import { and, asc, eq, sql } from "drizzle-orm";
import { eventTypes, expenseCategories, paymentMethods } from "@/db/schema";
import { recordAudit, type AuditAction, type AuditEntityType } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { notFound } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { mapNameConflict, moved, type NamedTable } from "./names";
import type { ListKind } from "./schemas";

/**
 * Event types (D-30), payment methods (D-31) and expense categories: the same small
 * list behavior (`settings.manage`, API.md). Never deleted, only deactivated.
 */

type ListConfig = {
  table: NamedTable;
  /** Has `sort_order` (expense categories are listed by name, DATA_MODEL §1). */
  ordered: boolean;
  /** Has `is_wedding` (event types). */
  wedding: boolean;
  audit: "event_types" | "payment_methods" | "expense_categories";
  entity: AuditEntityType;
  constraint: string;
};

const LISTS: Record<ListKind, ListConfig> = {
  eventTypes: {
    table: eventTypes,
    ordered: true,
    wedding: true,
    audit: "event_types",
    entity: "event_type",
    constraint: "event_types_venue_name_unique",
  },
  paymentMethods: {
    table: paymentMethods,
    ordered: true,
    wedding: false,
    audit: "payment_methods",
    entity: "payment_method",
    constraint: "payment_methods_venue_name_unique",
  },
  expenseCategories: {
    table: expenseCategories,
    ordered: false,
    wedding: false,
    audit: "expense_categories",
    entity: "expense_category",
    constraint: "expense_categories_venue_name_unique",
  },
};

/** The superset shape (event types); columns a list lacks are never referenced (see `ordered`, `wedding`). */
const tableOf = (kind: ListKind) => LISTS[kind].table as unknown as typeof eventTypes;

/** Suggested names, added with one click (D-71). The first event type is a wedding. */
export const SUGGESTED: Record<ListKind, { name: string; isWedding?: boolean }[]> = {
  eventTypes: [
    { name: "فرح", isWedding: true },
    { name: "خطوبة" },
    { name: "كتب كتاب" },
    { name: "حنة" },
    { name: "عيد ميلاد" },
    { name: "مناسبة أخرى" },
  ],
  paymentMethods: [{ name: "نقدي" }, { name: "إنستاباي" }, { name: "محفظة إلكترونية" }, { name: "تحويل بنكي" }],
  expenseCategories: [
    { name: "رواتب" },
    { name: "كهرباء ومياه" },
    { name: "صيانة" },
    { name: "مستلزمات" },
    { name: "إيجار" },
    { name: "أخرى" },
  ],
};

export type ListItem = { id: string; name: string; isWedding: boolean; isActive: boolean; sortOrder: number };

async function readItems(db: DbOrTx, kind: ListKind, venueId: string): Promise<ListItem[]> {
  const { ordered, wedding } = LISTS[kind];
  const table = tableOf(kind);
  const rows = await db
    .select({
      id: table.id,
      name: table.name,
      isActive: table.isActive,
      ...(ordered ? { sortOrder: table.sortOrder } : {}),
      ...(wedding ? { isWedding: table.isWedding } : {}),
    })
    .from(table)
    .where(eq(table.venueId, venueId))
    .orderBy(...(ordered ? [asc(table.sortOrder)] : []), asc(table.name));
  return rows.map((r, i) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    isWedding: wedding ? Boolean(r.isWedding) : false,
    sortOrder: ordered ? (r.sortOrder ?? i) : i,
  }));
}

async function readItem(tx: Tx, kind: ListKind, venueId: string, id: string) {
  const item = (await readItems(tx, kind, venueId)).find((i) => i.id === id);
  if (!item) throw notFound("itemNotFound");
  return item;
}

const snapshot = (kind: ListKind, item: ListItem) =>
  LISTS[kind].wedding
    ? { name: item.name, isWedding: item.isWedding, isActive: item.isActive }
    : { name: item.name, isActive: item.isActive };

const action = (kind: ListKind, verb: string) => `${LISTS[kind].audit}.${verb}` as AuditAction;

export async function listItems(db: DbOrTx, actor: SessionUser, kind: ListKind) {
  assertAllowed(actor, "settings.manage");
  return readItems(db, kind, actor.venueId);
}

async function nextSortOrder(tx: Tx, kind: ListKind, venueId: string) {
  if (!LISTS[kind].ordered) return {};
  const table = tableOf(kind);
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${table.sortOrder}), -1)::int` })
    .from(table)
    .where(eq(table.venueId, venueId));
  return { sortOrder: max + 1 };
}

async function insertItem(tx: Tx, actor: SessionUser, kind: ListKind, input: { name: string; isWedding?: boolean }) {
  const table = tableOf(kind);
  const [row] = await tx
    .insert(table)
    .values({
      venueId: actor.venueId,
      name: input.name,
      ...(LISTS[kind].wedding ? { isWedding: input.isWedding ?? false } : {}),
      ...(await nextSortOrder(tx, kind, actor.venueId)),
    })
    .returning({ id: table.id });
  const item = await readItem(tx, kind, actor.venueId, row.id);
  return { id: row.id, item };
}

export async function createListItem(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { kind: ListKind; name: string; isWedding?: boolean },
) {
  assertAllowed(actor, "settings.manage");
  const { kind } = input;
  return deps.db
    .transaction(async (tx) => {
      const { id, item } = await insertItem(tx, actor, kind, input);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: action(kind, "create"),
        entityType: LISTS[kind].entity,
        entityId: id,
        after: snapshot(kind, item),
      });
      return { id };
    })
    .catch((e: unknown) =>
      mapNameConflict(e, deps.db, LISTS[kind].table, LISTS[kind].constraint, actor.venueId, input.name),
    );
}

export async function updateListItem(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { kind: ListKind; id: string; name: string; isWedding?: boolean },
) {
  assertAllowed(actor, "settings.manage");
  const { kind } = input;
  const table = tableOf(kind);
  await deps.db
    .transaction(async (tx) => {
      const before = await readItem(tx, kind, actor.venueId, input.id);
      await tx
        .update(table)
        .set({ name: input.name, ...(LISTS[kind].wedding ? { isWedding: input.isWedding ?? false } : {}) })
        .where(and(eq(table.id, input.id), eq(table.venueId, actor.venueId)));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: action(kind, "update"),
        entityType: LISTS[kind].entity,
        entityId: input.id,
        before: snapshot(kind, before),
        after: snapshot(kind, await readItem(tx, kind, actor.venueId, input.id)),
      });
    })
    .catch((e: unknown) =>
      mapNameConflict(e, deps.db, LISTS[kind].table, LISTS[kind].constraint, actor.venueId, input.name),
    );
}

export async function setListItemActive(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { kind: ListKind; id: string; active: boolean },
) {
  assertAllowed(actor, "settings.manage");
  const { kind } = input;
  const table = tableOf(kind);
  await deps.db.transaction(async (tx) => {
    const before = await readItem(tx, kind, actor.venueId, input.id);
    if (before.isActive === input.active) return;
    await tx
      .update(table)
      .set({ isActive: input.active })
      .where(and(eq(table.id, input.id), eq(table.venueId, actor.venueId)));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: action(kind, input.active ? "activate" : "deactivate"),
      entityType: LISTS[kind].entity,
      entityId: input.id,
      before: snapshot(kind, before),
      after: snapshot(kind, { ...before, isActive: input.active }),
    });
  });
}

/** Reorders by rewriting `sort_order` 0..n-1 (lists are short). Expense categories sort by name. */
export async function moveListItem(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { kind: "eventTypes" | "paymentMethods"; id: string; direction: "up" | "down" },
) {
  assertAllowed(actor, "settings.manage");
  const { kind } = input;
  const table = tableOf(kind);
  await deps.db.transaction(async (tx) => {
    const items = await readItems(tx, kind, actor.venueId);
    const next = moved(items, input.id, input.direction);
    if (!next) throw notFound("itemNotFound");
    if (next.every((item, i) => item.id === items[i].id)) return;
    for (const [i, item] of next.entries()) {
      if (item.sortOrder !== i) {
        await tx
          .update(table)
          .set({ sortOrder: i })
          .where(and(eq(table.id, item.id), eq(table.venueId, actor.venueId)));
      }
    }
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: action(kind, "reorder"),
      entityType: LISTS[kind].entity,
      entityId: input.id,
      before: { order: items.map((i) => i.name) },
      after: { order: next.map((i) => i.name) },
    });
  });
}

/** D-71: adds the suggested names that are not there yet (by name, ignoring case), one audit row each. */
export async function addSuggestedItems(deps: ServiceDeps, actor: SessionUser, input: { kind: ListKind }) {
  assertAllowed(actor, "settings.manage");
  const { kind } = input;
  return deps.db.transaction(async (tx) => {
    const existing = new Set((await readItems(tx, kind, actor.venueId)).map((i) => i.name.toLowerCase()));
    let added = 0;
    for (const suggestion of SUGGESTED[kind]) {
      if (existing.has(suggestion.name.toLowerCase())) continue;
      const { id, item } = await insertItem(tx, actor, kind, suggestion);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: action(kind, "create"),
        entityType: LISTS[kind].entity,
        entityId: id,
        after: snapshot(kind, item),
        meta: { source: "suggested" },
      });
      added++;
    }
    return { added };
  });
}
