import { asc, eq } from "drizzle-orm";
import { cancellationTiers, spaces, spaceSlots, venues } from "@/db/schema";
import { sortTiers, tierViolation, type CancellationTier } from "@/domain/cancellation-tiers";
import { maxBufferFor, slotViolations, toHhMm, type SpaceSlotTimes } from "@/domain/slots";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";

export type VenueSettings = {
  name: string;
  phone: string | null;
  address: string | null;
  bufferMinutes: number;
  tentativeHoldHours: number;
  minDepositType: "none" | "fixed" | "percent";
  minDepositValue: number;
  cancellationBasis: "deposit" | "total_paid";
  postponeCreditMode: "refund" | "services" | "both";
  tiers: CancellationTier[];
};

const venueColumns = {
  name: venues.name,
  phone: venues.phone,
  address: venues.address,
  bufferMinutes: venues.bufferMinutes,
  tentativeHoldHours: venues.tentativeHoldHours,
  minDepositType: venues.minDepositType,
  minDepositValue: venues.minDepositValue,
  cancellationBasis: venues.cancellationBasis,
  postponeCreditMode: venues.postponeCreditMode,
};

async function readSettings(db: DbOrTx, venueId: string, lock = false): Promise<VenueSettings> {
  const query = db.select(venueColumns).from(venues).where(eq(venues.id, venueId));
  const [venue] = await (lock ? query.for("update") : query);
  if (!venue) throw new AppError("NOT_FOUND", "venueNotSetUp");
  const tiers = await db
    .select({ minDaysBefore: cancellationTiers.minDaysBefore, refundBps: cancellationTiers.refundBps })
    .from(cancellationTiers)
    .where(eq(cancellationTiers.venueId, venueId))
    .orderBy(asc(cancellationTiers.minDaysBefore));
  return { ...venue, tiers };
}

/**
 * Locks the venue row for the rest of the transaction. Every change that BR-02 depends on
 * (the buffer, any space's slot times) takes this lock first, so two concurrent changes
 * that are each valid alone cannot combine into a broken state.
 */
export async function lockVenue(tx: Tx, venueId: string) {
  const [venue] = await tx
    .select({ bufferMinutes: venues.bufferMinutes, tentativeHoldHours: venues.tentativeHoldHours })
    .from(venues)
    .where(eq(venues.id, venueId))
    .for("update");
  if (!venue) throw new AppError("NOT_FOUND", "venueNotSetUp");
  return venue;
}

/** Slot times of every space, active or not (D-69: the buffer must suit all of them). */
export async function allSpaceSlots(
  db: DbOrTx,
  venueId: string,
): Promise<{ spaceId: string; slots: SpaceSlotTimes }[]> {
  const rows = await db
    .select({
      spaceId: spaceSlots.spaceId,
      kind: spaceSlots.kind,
      start: spaceSlots.startTime,
      end: spaceSlots.endTime,
    })
    .from(spaceSlots)
    .innerJoin(spaces, eq(spaces.id, spaceSlots.spaceId))
    .where(eq(spaces.venueId, venueId));
  const bySpace = new Map<string, Partial<SpaceSlotTimes>>();
  for (const r of rows) {
    const entry = bySpace.get(r.spaceId) ?? {};
    entry[r.kind] = { start: toHhMm(r.start), end: toHhMm(r.end) };
    bySpace.set(r.spaceId, entry);
  }
  return [...bySpace].flatMap(([spaceId, s]) => (s.day && s.evening ? [{ spaceId, slots: s as SpaceSlotTimes }] : []));
}

/** S-13 (`settings.manage`): venue data, timing and policies with the current tiers. */
export async function getVenueSettings(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "settings.manage");
  const settings = await readSettings(db, actor.venueId);
  // The largest buffer the current slot times allow (D-51), shown next to the field.
  const limits = (await allSpaceSlots(db, actor.venueId)).map((s) => maxBufferFor(s.slots) ?? 0);
  return { ...settings, maxBufferMinutes: limits.length > 0 ? Math.min(...limits) : null };
}

export type UpdateVenueInput = { name: string; phone: string | null; address: string | null };

/** Logo upload comes with documents in phase 9 (D-70). */
export async function updateVenue(deps: ServiceDeps, actor: SessionUser, input: UpdateVenueInput) {
  assertAllowed(actor, "settings.manage");
  await deps.db.transaction(async (tx) => {
    const before = await readSettings(tx, actor.venueId, true);
    await tx.update(venues).set(input).where(eq(venues.id, actor.venueId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "settings.venue_updated",
      entityType: "venue",
      entityId: actor.venueId,
      before: { name: before.name, phone: before.phone, address: before.address },
      after: input,
    });
  });
}

export type UpdateTimingInput = { bufferMinutes: number; tentativeHoldHours: number };

/**
 * D-51 / D-69: a buffer that breaks BR-02 for any space (active or not) is refused.
 * Existing bookings keep their stored `blocked_until` (BR-10).
 */
export async function updateTiming(deps: ServiceDeps, actor: SessionUser, input: UpdateTimingInput) {
  assertAllowed(actor, "settings.manage");
  await deps.db.transaction(async (tx) => {
    const before = await lockVenue(tx, actor.venueId);
    if (input.bufferMinutes !== before.bufferMinutes) {
      const broken = (await allSpaceSlots(tx, actor.venueId)).some(
        (s) => slotViolations(s.slots, input.bufferMinutes).length > 0,
      );
      if (broken) {
        throw new AppError("BUSINESS_RULE_VIOLATION", "bufferBreaksSlots", {
          rule: "BR-02",
          fieldErrors: { bufferMinutes: "bufferBreaksSlots" },
        });
      }
    }
    await tx.update(venues).set(input).where(eq(venues.id, actor.venueId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "settings.timing_updated",
      entityType: "venue",
      entityId: actor.venueId,
      before,
      after: input,
    });
  });
}

export type UpdatePoliciesInput = {
  minDepositType: "none" | "fixed" | "percent";
  minDepositValue: number;
  cancellationBasis: "deposit" | "total_paid";
  postponeCreditMode: "refund" | "services" | "both";
  tiers: CancellationTier[];
};

/**
 * D-19, D-20, D-22. The tiers are replaced as one set (BR-77, D-67). They apply to bookings
 * confirmed from now on; confirmed bookings keep their own snapshot (D-68).
 */
export async function updatePolicies(deps: ServiceDeps, actor: SessionUser, input: UpdatePoliciesInput) {
  assertAllowed(actor, "settings.manage");
  const violation = tierViolation(input.tiers);
  if (violation) {
    throw new AppError("BUSINESS_RULE_VIOLATION", violation, { rule: "BR-77", fieldErrors: { tiers: violation } });
  }
  const tiers = sortTiers(input.tiers);
  const venueFields = {
    minDepositType: input.minDepositType,
    minDepositValue: input.minDepositValue,
    cancellationBasis: input.cancellationBasis,
    postponeCreditMode: input.postponeCreditMode,
  };
  await deps.db.transaction(async (tx) => {
    const before = await readSettings(tx, actor.venueId, true);
    await tx.update(venues).set(venueFields).where(eq(venues.id, actor.venueId));
    await tx.delete(cancellationTiers).where(eq(cancellationTiers.venueId, actor.venueId));
    await tx.insert(cancellationTiers).values(tiers.map((t) => ({ venueId: actor.venueId, ...t })));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "settings.policies_updated",
      entityType: "venue",
      entityId: actor.venueId,
      before: policySnapshot(before),
      after: { ...venueFields, tiers },
    });
  });
}

const policySnapshot = (s: VenueSettings) => ({
  minDepositType: s.minDepositType,
  minDepositValue: s.minDepositValue,
  cancellationBasis: s.cancellationBasis,
  postponeCreditMode: s.postponeCreditMode,
  tiers: s.tiers,
});
