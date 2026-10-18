import { and, eq } from "drizzle-orm";
import { seasons, spaces } from "@/db/schema";
import { quotePrice, type PriceBreakdown, type PricingCatalog, type PricingViolation } from "@/domain/pricing";
import type { SessionUser } from "@/modules/auth/sessions";
import { readServices } from "@/modules/catalog/services";
import { readPackage } from "@/modules/packages/service";
import type { DbOrTx } from "@/modules/shared/db";
import { AppError, notFound } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import type { QuoteInput } from "./schemas";

/**
 * `pricing.quote` (API.md, `bookings.view`): the current catalog of the venue → the pure
 * engine (src/domain/pricing.ts). Read-only — no writes, no audit — and always on current
 * prices, so re-pricing at confirmation (D-41) is the same call.
 */

type Mapped = { code: "BUSINESS_RULE_VIOLATION" | "VALIDATION_ERROR" | "NOT_FOUND"; rule?: string; field?: string };

const VIOLATIONS: Record<PricingViolation, Mapped> = {
  guestsInvalid: { code: "VALIDATION_ERROR", field: "guests" },
  discountInvalid: { code: "VALIDATION_ERROR", field: "discountAmount" },
  slotNotPriced: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30", field: "slotKind" },
  removedDuplicate: { code: "VALIDATION_ERROR", field: "removedServiceIds" },
  itemNotIncluded: { code: "VALIDATION_ERROR", field: "removedServiceIds" },
  itemNotRemovable: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-33", field: "removedServiceIds" },
  addedDuplicate: { code: "VALIDATION_ERROR", field: "items" },
  serviceUnknown: { code: "NOT_FOUND" },
  serviceInactive: { code: "BUSINESS_RULE_VIOLATION", rule: "D-87", field: "items" },
  alreadyIncluded: { code: "BUSINESS_RULE_VIOLATION", rule: "D-90", field: "items" },
  quantityInvalid: { code: "VALIDATION_ERROR", field: "items" },
  externalNotAllowed: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-34", field: "items" },
  amountTooLarge: { code: "VALIDATION_ERROR" },
  negativeTotal: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-35" },
  discountExceedsSubtotal: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-52", field: "discountAmount" },
};

/** The engine's refusal as an API error; item errors are keyed by service (`items.<serviceId>`). */
function toAppError(violation: PricingViolation, serviceId?: string): AppError {
  if (violation === "serviceUnknown") return notFound("serviceNotFound");
  const { code, rule, field } = VIOLATIONS[violation];
  const key = field && serviceId ? `${field}.${serviceId}` : field;
  return new AppError(code, violation, { rule, fieldErrors: key ? { [key]: violation } : undefined });
}

/** Everything the engine needs, read for the actor's venue only (T-05). */
async function readCatalog(db: DbOrTx, venueId: string, input: QuoteInput): Promise<PricingCatalog> {
  const pkg = await readPackage(db, venueId, input.packageId);
  if (pkg.spaceId !== input.spaceId) throw notFound("packageNotFound");
  const [[space], seasonRows, serviceRows] = await Promise.all([
    db
      .select({ isActive: spaces.isActive })
      .from(spaces)
      .where(and(eq(spaces.id, pkg.spaceId), eq(spaces.venueId, venueId))),
    db
      .select({ id: seasons.id, startDate: seasons.startDate, endDate: seasons.endDate })
      .from(seasons)
      .where(and(eq(seasons.venueId, venueId), eq(seasons.isActive, true))),
    readServices(db, venueId),
  ]);
  if (!pkg.isActive) throw new AppError("BUSINESS_RULE_VIOLATION", "packageInactive", { rule: "D-87" });
  if (!space?.isActive) throw new AppError("BUSINESS_RULE_VIOLATION", "spaceInactiveForBooking", { rule: "BR-06" });

  const services = new Map(serviceRows.map((s) => [s.id, s]));
  return {
    package: {
      baseGuests: pkg.baseGuests,
      extraGuestPrice: pkg.extraGuestPrice,
      prices: pkg.prices,
      // Included services belong to the same venue (D-82: never deleted).
      included: pkg.items.map((item) => ({
        service: services.get(item.serviceId)!,
        quantity: item.quantity,
        removable: item.removable,
        removalCredit: item.removalCredit,
      })),
    },
    activeSeasons: seasonRows,
    services,
  };
}

export async function quote(db: DbOrTx, actor: SessionUser, input: QuoteInput): Promise<PriceBreakdown> {
  assertAllowed(actor, "bookings.view");
  return quoteForVenue(db, actor.venueId, input);
}

/**
 * The same quote for a caller that already checked its own permission — saving a booking
 * (`bookings.create` / `bookings.edit`) prices it inside its transaction.
 */
export async function quoteForVenue(db: DbOrTx, venueId: string, input: QuoteInput): Promise<PriceBreakdown> {
  const catalog = await readCatalog(db, venueId, input);
  const result = quotePrice(catalog, {
    slotKind: input.slotKind,
    eventDate: input.eventDate,
    guests: input.guests,
    added: input.items,
    removedServiceIds: input.removedServiceIds,
    discountAmount: input.discountAmount,
  });
  if (!result.ok) throw toAppError(result.violation, result.serviceId);
  return result.breakdown;
}
