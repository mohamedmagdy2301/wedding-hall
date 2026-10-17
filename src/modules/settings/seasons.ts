import { and, asc, eq } from "drizzle-orm";
import { seasons } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, notFound, pgError } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { mapNameConflict } from "./names";

/**
 * Seasons (`catalog.manage`, D-66). Active seasons never overlap: the database constraint
 * `seasons_no_overlap` is the guarantee (BR-31); its violation becomes a field error.
 * Never deleted, only deactivated.
 */

export type Season = { id: string; name: string; startDate: string; endDate: string; isActive: boolean };

const columns = {
  id: seasons.id,
  name: seasons.name,
  startDate: seasons.startDate,
  endDate: seasons.endDate,
  isActive: seasons.isActive,
};

export async function listSeasons(db: DbOrTx, actor: SessionUser): Promise<Season[]> {
  assertAllowed(actor, "catalog.manage");
  return db
    .select(columns)
    .from(seasons)
    .where(eq(seasons.venueId, actor.venueId))
    .orderBy(asc(seasons.startDate), asc(seasons.name));
}

async function readSeason(tx: Tx, venueId: string, seasonId: string) {
  const [season] = await tx
    .select(columns)
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.venueId, venueId)));
  if (!season) throw notFound("seasonNotFound");
  return season;
}

const snapshot = (s: Season) => ({ name: s.name, startDate: s.startDate, endDate: s.endDate, isActive: s.isActive });

async function mapErrors(error: unknown, deps: ServiceDeps, actor: SessionUser, name: string): Promise<never> {
  const e = pgError(error);
  if (e.code === "23P01" && e.constraint === "seasons_no_overlap") {
    throw new AppError("BUSINESS_RULE_VIOLATION", "seasonOverlap", {
      rule: "BR-31",
      fieldErrors: { startDate: "seasonOverlap" },
    });
  }
  return mapNameConflict(error, deps.db, seasons, "seasons_venue_name_unique", actor.venueId, name);
}

export type SeasonInput = { name: string; startDate: string; endDate: string };

export async function createSeason(deps: ServiceDeps, actor: SessionUser, input: SeasonInput) {
  assertAllowed(actor, "catalog.manage");
  return deps.db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(seasons)
        .values({ venueId: actor.venueId, ...input })
        .returning({ id: seasons.id });
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "seasons.create",
        entityType: "season",
        entityId: row.id,
        after: { ...input, isActive: true },
      });
      return { id: row.id };
    })
    .catch((e: unknown) => mapErrors(e, deps, actor, input.name));
}

/** Changing dates never touches confirmed bookings: their season and price are snapshots (BR-37). */
export async function updateSeason(deps: ServiceDeps, actor: SessionUser, input: SeasonInput & { seasonId: string }) {
  assertAllowed(actor, "catalog.manage");
  const { seasonId, ...fields } = input;
  await deps.db
    .transaction(async (tx) => {
      const before = await readSeason(tx, actor.venueId, seasonId);
      await tx
        .update(seasons)
        .set(fields)
        .where(and(eq(seasons.id, seasonId), eq(seasons.venueId, actor.venueId)));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "seasons.update",
        entityType: "season",
        entityId: seasonId,
        before: snapshot(before),
        after: { ...fields, isActive: before.isActive },
      });
    })
    .catch((e: unknown) => mapErrors(e, deps, actor, input.name));
}

/** Reactivating a season that overlaps an active one is refused by the constraint (BR-31). */
export async function setSeasonActive(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { seasonId: string; active: boolean },
) {
  assertAllowed(actor, "catalog.manage");
  await deps.db
    .transaction(async (tx) => {
      const before = await readSeason(tx, actor.venueId, input.seasonId);
      if (before.isActive === input.active) return;
      await tx
        .update(seasons)
        .set({ isActive: input.active })
        .where(and(eq(seasons.id, input.seasonId), eq(seasons.venueId, actor.venueId)));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: input.active ? "seasons.activate" : "seasons.deactivate",
        entityType: "season",
        entityId: input.seasonId,
        before: snapshot(before),
        after: { ...snapshot(before), isActive: input.active },
      });
    })
    .catch((e: unknown) => mapErrors(e, deps, actor, ""));
}
