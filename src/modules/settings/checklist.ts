import { and, count, countDistinct, eq, isNull } from "drizzle-orm";
import {
  cancellationTiers,
  eventTypes,
  packagePrices,
  packages,
  paymentMethods,
  seasons,
  services,
  spaces,
  users,
  venues,
} from "@/db/schema";
import { bookingReadinessGaps, setupChecklist, type SetupFacts } from "@/domain/setup-checklist";
import type { SessionUser } from "@/modules/auth/sessions";
import type { DbOrTx } from "@/modules/shared/db";
import { AppError } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";

const first = async (query: PromiseLike<{ n: number }[]>) => (await query)[0].n;

/** The facts behind UF-02 (D-71, D-77), read in parallel. */
export async function setupFacts(db: DbOrTx, venueId: string): Promise<SetupFacts> {
  const [venue] = await db
    .select({ name: venues.name, phone: venues.phone, address: venues.address })
    .from(venues)
    .where(eq(venues.id, venueId));
  if (!venue) throw new AppError("NOT_FOUND", "venueNotSetUp");
  const n = { n: count() };
  const [
    activeSpaces,
    activeSeasons,
    activeEventTypes,
    activePaymentMethods,
    tiers,
    activeStaff,
    activeServices,
    pricedPackages,
  ] = await Promise.all([
    first(
      db
        .select(n)
        .from(spaces)
        .where(and(eq(spaces.venueId, venueId), eq(spaces.isActive, true))),
    ),
    first(
      db
        .select(n)
        .from(seasons)
        .where(and(eq(seasons.venueId, venueId), eq(seasons.isActive, true))),
    ),
    first(
      db
        .select(n)
        .from(eventTypes)
        .where(and(eq(eventTypes.venueId, venueId), eq(eventTypes.isActive, true))),
    ),
    first(
      db
        .select(n)
        .from(paymentMethods)
        .where(and(eq(paymentMethods.venueId, venueId), eq(paymentMethods.isActive, true))),
    ),
    first(db.select(n).from(cancellationTiers).where(eq(cancellationTiers.venueId, venueId))),
    first(
      db
        .select(n)
        .from(users)
        .where(and(eq(users.venueId, venueId), eq(users.isActive, true), eq(users.isOwner, false))),
    ),
    first(
      db
        .select(n)
        .from(services)
        .where(and(eq(services.venueId, venueId), eq(services.isActive, true))),
    ),
    // Bookable: an active package on an active space (BR-06) with a regular price (BR-30, D-77).
    first(
      db
        .select({ n: countDistinct(packages.id) })
        .from(packages)
        .innerJoin(spaces, eq(spaces.id, packages.spaceId))
        .innerJoin(packagePrices, and(eq(packagePrices.packageId, packages.id), isNull(packagePrices.seasonId)))
        .where(and(eq(packages.venueId, venueId), eq(packages.isActive, true), eq(spaces.isActive, true))),
    ),
  ]);
  return {
    venue,
    activeSpaces,
    activeSeasons,
    activeEventTypes,
    activePaymentMethods,
    cancellationTiers: tiers,
    activeStaff,
    activeServices,
    pricedPackages,
  };
}

/** S-14 is the owner's guided setup (UF-02). */
export async function getSetupChecklist(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "owner");
  const facts = await setupFacts(db, actor.venueId);
  return { ...setupChecklist(facts), facts };
}

/** UF-02 step 3 / BR-21 (5): what blocks confirming any booking. Used by bookings from phase 6. */
export async function bookingReadiness(db: DbOrTx, venueId: string) {
  const gaps = bookingReadinessGaps(await setupFacts(db, venueId));
  return { ready: gaps.length === 0, gaps };
}
