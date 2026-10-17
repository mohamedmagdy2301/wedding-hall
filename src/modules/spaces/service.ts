import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { spaces, spaceSlots } from "@/db/schema";
import { slotViolations, toHhMm, type SpaceSlotTimes } from "@/domain/slots";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { lockVenue } from "@/modules/settings/venue";
import { mapNameConflict, moved } from "@/modules/settings/names";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, notFound } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";

/**
 * Spaces and their two default slots (`catalog.manage`, BR-01, D-02, D-05). Never deleted,
 * only deactivated. Slot times are checked against the buffer under the venue lock (BR-02).
 */

export type Space = SpaceSlotTimes & {
  id: string;
  name: string;
  capacityMax: number | null;
  isActive: boolean;
  sortOrder: number;
};

async function readSpaces(db: DbOrTx, venueId: string, ids?: string[]): Promise<Space[]> {
  const where = ids ? and(eq(spaces.venueId, venueId), inArray(spaces.id, ids)) : eq(spaces.venueId, venueId);
  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      capacityMax: spaces.capacityMax,
      isActive: spaces.isActive,
      sortOrder: spaces.sortOrder,
    })
    .from(spaces)
    .where(where)
    .orderBy(asc(spaces.sortOrder), asc(spaces.name));
  if (rows.length === 0) return [];
  const slots = await db
    .select({
      spaceId: spaceSlots.spaceId,
      kind: spaceSlots.kind,
      start: spaceSlots.startTime,
      end: spaceSlots.endTime,
    })
    .from(spaceSlots)
    .where(
      inArray(
        spaceSlots.spaceId,
        rows.map((r) => r.id),
      ),
    );
  const slot = (spaceId: string, kind: "day" | "evening") => {
    const s = slots.find((x) => x.spaceId === spaceId && x.kind === kind);
    return s ? { start: toHhMm(s.start), end: toHhMm(s.end) } : { start: "", end: "" };
  };
  return rows.map((r) => ({ ...r, day: slot(r.id, "day"), evening: slot(r.id, "evening") }));
}

async function readSpace(tx: Tx, venueId: string, spaceId: string) {
  const [space] = await readSpaces(tx, venueId, [spaceId]);
  if (!space) throw notFound("spaceNotFound");
  return space;
}

const snapshot = (s: Space) => ({
  name: s.name,
  capacityMax: s.capacityMax,
  isActive: s.isActive,
  day: s.day,
  evening: s.evening,
});

export async function listSpaces(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "catalog.manage");
  return readSpaces(db, actor.venueId);
}

export type SpaceInput = SpaceSlotTimes & { name: string; capacityMax: number | null };

/** BR-01/BR-02 with the current buffer; the field errors point at the slot to fix. */
function assertSlots(slots: SpaceSlotTimes, bufferMinutes: number) {
  const [violation] = slotViolations(slots, bufferMinutes);
  if (!violation) return;
  const field = {
    zeroLength: "day.end",
    dayCrossesMidnight: "day.end",
    eveningTooEarly: "evening.start",
    eveningIntoNextDay: "evening.end",
  }[violation];
  const rule = violation === "eveningTooEarly" || violation === "eveningIntoNextDay" ? "BR-02" : "BR-01";
  throw new AppError("BUSINESS_RULE_VIOLATION", violation, { rule, fieldErrors: { [field]: violation } });
}

const slotRows = (venueId: string, spaceId: string, input: SpaceSlotTimes) =>
  (["day", "evening"] as const).map((kind) => ({
    venueId,
    spaceId,
    kind,
    startTime: input[kind].start,
    endTime: input[kind].end,
  }));

export async function createSpace(deps: ServiceDeps, actor: SessionUser, input: SpaceInput) {
  assertAllowed(actor, "catalog.manage");
  return deps.db
    .transaction(async (tx) => {
      const { bufferMinutes } = await lockVenue(tx, actor.venueId);
      assertSlots(input, bufferMinutes);
      const [{ max }] = await tx
        .select({ max: sql<number>`coalesce(max(${spaces.sortOrder}), -1)::int` })
        .from(spaces)
        .where(eq(spaces.venueId, actor.venueId));
      const [row] = await tx
        .insert(spaces)
        .values({ venueId: actor.venueId, name: input.name, capacityMax: input.capacityMax, sortOrder: max + 1 })
        .returning({ id: spaces.id });
      await tx.insert(spaceSlots).values(slotRows(actor.venueId, row.id, input));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "spaces.create",
        entityType: "space",
        entityId: row.id,
        after: snapshot(await readSpace(tx, actor.venueId, row.id)),
      });
      return { id: row.id };
    })
    .catch((e: unknown) => mapNameConflict(e, deps.db, spaces, "spaces_venue_name_unique", actor.venueId, input.name));
}

/** New slot times apply to new bookings; existing ones keep their stored times (BR-03, BR-10). */
export async function updateSpace(deps: ServiceDeps, actor: SessionUser, input: SpaceInput & { spaceId: string }) {
  assertAllowed(actor, "catalog.manage");
  await deps.db
    .transaction(async (tx) => {
      const { bufferMinutes } = await lockVenue(tx, actor.venueId);
      const before = await readSpace(tx, actor.venueId, input.spaceId);
      assertSlots(input, bufferMinutes);
      await tx
        .update(spaces)
        .set({ name: input.name, capacityMax: input.capacityMax })
        .where(and(eq(spaces.id, input.spaceId), eq(spaces.venueId, actor.venueId)));
      for (const row of slotRows(actor.venueId, input.spaceId, input)) {
        await tx
          .update(spaceSlots)
          .set({ startTime: row.startTime, endTime: row.endTime })
          .where(and(eq(spaceSlots.spaceId, input.spaceId), eq(spaceSlots.kind, row.kind)));
      }
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "spaces.update",
        entityType: "space",
        entityId: input.spaceId,
        before: snapshot(before),
        after: snapshot(await readSpace(tx, actor.venueId, input.spaceId)),
      });
    })
    .catch((e: unknown) => mapNameConflict(e, deps.db, spaces, "spaces_venue_name_unique", actor.venueId, input.name));
}

/** Deactivated spaces stay valid for the buffer (D-69), so reactivation needs no new check. */
export async function setSpaceActive(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { spaceId: string; active: boolean },
) {
  assertAllowed(actor, "catalog.manage");
  await deps.db.transaction(async (tx) => {
    const before = await readSpace(tx, actor.venueId, input.spaceId);
    if (before.isActive === input.active) return;
    await tx
      .update(spaces)
      .set({ isActive: input.active })
      .where(and(eq(spaces.id, input.spaceId), eq(spaces.venueId, actor.venueId)));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: input.active ? "spaces.activate" : "spaces.deactivate",
      entityType: "space",
      entityId: input.spaceId,
      before: snapshot(before),
      after: { ...snapshot(before), isActive: input.active },
    });
  });
}

export async function moveSpace(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { spaceId: string; direction: "up" | "down" },
) {
  assertAllowed(actor, "catalog.manage");
  await deps.db.transaction(async (tx) => {
    const items = await readSpaces(tx, actor.venueId);
    const next = moved(items, input.spaceId, input.direction);
    if (!next) throw notFound("spaceNotFound");
    if (next.every((item, i) => item.id === items[i].id)) return;
    for (const [i, item] of next.entries()) {
      if (item.sortOrder !== i) {
        await tx
          .update(spaces)
          .set({ sortOrder: i })
          .where(and(eq(spaces.id, item.id), eq(spaces.venueId, actor.venueId)));
      }
    }
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "spaces.reorder",
      entityType: "space",
      entityId: input.spaceId,
      before: { order: items.map((i) => i.name) },
      after: { order: next.map((i) => i.name) },
    });
  });
}
