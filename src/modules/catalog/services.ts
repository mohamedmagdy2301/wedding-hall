import { and, asc, count, eq } from "drizzle-orm";
import { packageItems, services } from "@/db/schema";
import { SERVICE_CATEGORIES, type PricingType, type ServiceCategory } from "@/domain/catalog";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { mapNameConflict } from "@/modules/settings/names";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, notFound } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";

/**
 * Catalog services (`catalog.manage`, D-12, D-13, D-39). Never deleted, only deactivated
 * (D-82); a deactivated service stays in the packages that include it (D-80).
 */

export type Service = {
  id: string;
  name: string;
  category: ServiceCategory;
  pricingType: PricingType;
  unitPrice: number;
  allowExternal: boolean;
  externalFee: number;
  isActive: boolean;
};

const columns = {
  id: services.id,
  name: services.name,
  category: services.category,
  pricingType: services.pricingType,
  unitPrice: services.unitPrice,
  allowExternal: services.allowExternal,
  externalFee: services.externalFee,
  isActive: services.isActive,
};

const byCategoryThenName = (a: Service, b: Service) =>
  SERVICE_CATEGORIES.indexOf(a.category) - SERVICE_CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name, "ar");

/** Every service of the venue, by category then name (no `sort_order` in DATA_MODEL). */
export async function readServices(db: DbOrTx, venueId: string): Promise<Service[]> {
  const rows = await db.select(columns).from(services).where(eq(services.venueId, venueId)).orderBy(asc(services.name));
  return rows.sort(byCategoryThenName);
}

/** How many packages include each service (the deactivation warning, D-80). */
async function packageCounts(db: DbOrTx, venueId: string) {
  const rows = await db
    .select({ serviceId: packageItems.serviceId, n: count() })
    .from(packageItems)
    .where(eq(packageItems.venueId, venueId))
    .groupBy(packageItems.serviceId);
  return new Map(rows.map((r) => [r.serviceId, r.n]));
}

export type ServiceRow = Service & { packageCount: number };

export async function listServices(db: DbOrTx, actor: SessionUser): Promise<ServiceRow[]> {
  assertAllowed(actor, "catalog.manage");
  const [rows, counts] = await Promise.all([readServices(db, actor.venueId), packageCounts(db, actor.venueId)]);
  return rows.map((s) => ({ ...s, packageCount: counts.get(s.id) ?? 0 }));
}

async function readService(tx: Tx, venueId: string, serviceId: string) {
  const [service] = await tx
    .select(columns)
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.venueId, venueId)))
    .for("update");
  if (!service) throw notFound("serviceNotFound");
  return service;
}

const snapshot = (s: Service) => ({
  name: s.name,
  category: s.category,
  pricingType: s.pricingType,
  unitPrice: s.unitPrice,
  allowExternal: s.allowExternal,
  externalFee: s.externalFee,
  isActive: s.isActive,
});

export type ServiceInput = Omit<Service, "id" | "isActive">;

export async function createService(deps: ServiceDeps, actor: SessionUser, input: ServiceInput) {
  assertAllowed(actor, "catalog.manage");
  return deps.db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(services)
        .values({ venueId: actor.venueId, ...input })
        .returning({ id: services.id });
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "services.create",
        entityType: "service",
        entityId: row.id,
        after: { ...input, isActive: true },
      });
      return { id: row.id };
    })
    .catch((e: unknown) =>
      mapNameConflict(e, deps.db, services, "services_venue_name_unique", actor.venueId, input.name),
    );
}

/**
 * Bookings copy the name, price and pricing type when an item is added, so they are not
 * affected (BR-37, BR-40). The pricing type stays while a package includes the service,
 * because it gives the package's quantity its meaning (D-80).
 */
export async function updateService(
  deps: ServiceDeps,
  actor: SessionUser,
  input: ServiceInput & { serviceId: string },
) {
  assertAllowed(actor, "catalog.manage");
  const { serviceId, ...fields } = input;
  await deps.db
    .transaction(async (tx) => {
      const before = await readService(tx, actor.venueId, serviceId);
      if (fields.pricingType !== before.pricingType) {
        const [{ n }] = await tx.select({ n: count() }).from(packageItems).where(eq(packageItems.serviceId, serviceId));
        if (n > 0) {
          throw new AppError("BUSINESS_RULE_VIOLATION", "pricingTypeInUse", {
            rule: "D-80",
            fieldErrors: { pricingType: "pricingTypeInUse" },
          });
        }
      }
      await tx
        .update(services)
        .set(fields)
        .where(and(eq(services.id, serviceId), eq(services.venueId, actor.venueId)));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "services.update",
        entityType: "service",
        entityId: serviceId,
        before: snapshot(before),
        after: { ...fields, isActive: before.isActive },
      });
    })
    .catch((e: unknown) =>
      mapNameConflict(e, deps.db, services, "services_venue_name_unique", actor.venueId, input.name),
    );
}

/** Deactivating never edits packages: the service stays where it is included (D-80). */
export async function setServiceActive(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { serviceId: string; active: boolean },
) {
  assertAllowed(actor, "catalog.manage");
  await deps.db.transaction(async (tx) => {
    const before = await readService(tx, actor.venueId, input.serviceId);
    if (before.isActive === input.active) return;
    await tx
      .update(services)
      .set({ isActive: input.active })
      .where(and(eq(services.id, input.serviceId), eq(services.venueId, actor.venueId)));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: input.active ? "services.activate" : "services.deactivate",
      entityType: "service",
      entityId: input.serviceId,
      before: snapshot(before),
      after: { ...snapshot(before), isActive: input.active },
    });
  });
}
