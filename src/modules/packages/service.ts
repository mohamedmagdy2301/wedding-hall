import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { packageItems, packagePrices, packages, seasons, services, spaces } from "@/db/schema";
import {
  bookableSlotKinds,
  itemSetViolation,
  priceSetViolation,
  type ItemViolation,
  type PackageItem,
  type PackagePrice,
  type PriceViolation,
} from "@/domain/catalog";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { readServices } from "@/modules/catalog/services";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, isUniqueViolation, notFound, validationError } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";

/**
 * Packages (`catalog.manage`, D-10, D-11, D-14) with their prices per slot × season and
 * their included services, saved together as one set (D-81). Never deleted (D-82).
 *
 * Phase 3 acceptance: an active package has a regular price for at least one slot
 * (BR-30, D-56, D-78). Every change goes through the package row lock and its `version`
 * (optimistic locking, D-81), so neither a stale page nor two concurrent saves can leave
 * an active package without a regular price, or overwrite another person's edit.
 */

export type PackageFields = {
  name: string;
  description: string | null;
  baseGuests: number;
  extraGuestPrice: number;
  isActive: boolean;
  prices: PackagePrice[];
  items: PackageItem[];
};

export type PackageDetail = PackageFields & { id: string; spaceId: string; version: number };

const packageColumns = {
  id: packages.id,
  spaceId: packages.spaceId,
  name: packages.name,
  description: packages.description,
  baseGuests: packages.baseGuests,
  extraGuestPrice: packages.extraGuestPrice,
  isActive: packages.isActive,
  version: packages.version,
};

async function readChildren(db: DbOrTx, packageIds: string[]) {
  if (packageIds.length === 0) return { prices: [], items: [] };
  const [prices, items] = await Promise.all([
    db
      .select({
        packageId: packagePrices.packageId,
        slotKind: packagePrices.slotKind,
        seasonId: packagePrices.seasonId,
        price: packagePrices.price,
      })
      .from(packagePrices)
      .where(inArray(packagePrices.packageId, packageIds)),
    db
      .select({
        packageId: packageItems.packageId,
        serviceId: packageItems.serviceId,
        quantity: packageItems.quantity,
        removable: packageItems.removable,
        removalCredit: packageItems.removalCredit,
      })
      .from(packageItems)
      .where(inArray(packageItems.packageId, packageIds))
      .orderBy(asc(packageItems.sortOrder)),
  ]);
  return { prices, items };
}

const pricesOf = (rows: Awaited<ReturnType<typeof readChildren>>["prices"], packageId: string): PackagePrice[] =>
  rows.filter((r) => r.packageId === packageId).map(({ slotKind, seasonId, price }) => ({ slotKind, seasonId, price }));

const itemsOf = (rows: Awaited<ReturnType<typeof readChildren>>["items"], packageId: string): PackageItem[] =>
  rows
    .filter((r) => r.packageId === packageId)
    .map(({ serviceId, quantity, removable, removalCredit }) => ({ serviceId, quantity, removable, removalCredit }));

/** The package row, locked for the rest of the transaction when `lock` (D-81). Items in package order. */
export async function readPackage(
  db: DbOrTx,
  venueId: string,
  packageId: string,
  lock = false,
): Promise<PackageDetail> {
  const query = db
    .select(packageColumns)
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.venueId, venueId)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("packageNotFound");
  const children = await readChildren(db, [packageId]);
  return { ...row, prices: pricesOf(children.prices, packageId), items: itemsOf(children.items, packageId) };
}

export type PackageListRow = Awaited<ReturnType<typeof listPackages>>[number];
export type PackageFormOptions = Awaited<ReturnType<typeof formOptions>>;

/** S-13 list: every package with its space, bookable slots (D-56) and prices. */
export async function listPackages(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "catalog.manage");
  const rows = await db
    .select({
      ...packageColumns,
      spaceName: spaces.name,
      spaceActive: spaces.isActive,
    })
    .from(packages)
    .innerJoin(spaces, eq(spaces.id, packages.spaceId))
    .where(eq(packages.venueId, actor.venueId))
    .orderBy(asc(spaces.sortOrder), asc(spaces.name), asc(packages.name));
  const children = await readChildren(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const prices = pricesOf(children.prices, r.id);
    return {
      ...r,
      prices,
      itemCount: itemsOf(children.items, r.id).length,
      bookableSlots: bookableSlotKinds(prices),
    };
  });
}

/** The edit page: the package (with its `version`, D-81) and what its form chooses from. */
export async function getPackage(db: DbOrTx, actor: SessionUser, packageId: string) {
  assertAllowed(actor, "catalog.manage");
  const pkg = await readPackage(db, actor.venueId, packageId);
  return { package: pkg, ...(await formOptions(db, actor.venueId)) };
}

/** What the create and edit forms choose from: spaces, seasons and services (active or not). */
export async function formOptions(db: DbOrTx, venueId: string) {
  const [spaceRows, seasonRows, serviceRows] = await Promise.all([
    db
      .select({ id: spaces.id, name: spaces.name, isActive: spaces.isActive, capacityMax: spaces.capacityMax })
      .from(spaces)
      .where(eq(spaces.venueId, venueId))
      .orderBy(asc(spaces.sortOrder), asc(spaces.name)),
    db
      .select({
        id: seasons.id,
        name: seasons.name,
        startDate: seasons.startDate,
        endDate: seasons.endDate,
        isActive: seasons.isActive,
      })
      .from(seasons)
      .where(eq(seasons.venueId, venueId))
      .orderBy(asc(seasons.startDate), asc(seasons.name)),
    readServices(db, venueId),
  ]);
  return { spaces: spaceRows, seasons: seasonRows, services: serviceRows };
}

export async function getNewPackageOptions(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "catalog.manage");
  return formOptions(db, actor.venueId);
}

const PRICE_RULES: Record<PriceViolation, { code: "BUSINESS_RULE_VIOLATION" | "VALIDATION_ERROR"; rule?: string }> = {
  activeWithoutRegularPrice: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" },
  seasonPriceWithoutRegular: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-30" },
  inactiveSeasonPrice: { code: "BUSINESS_RULE_VIOLATION", rule: "D-78" },
  priceDuplicate: { code: "VALIDATION_ERROR" },
};

const ITEM_RULES: Record<ItemViolation, { code: "BUSINESS_RULE_VIOLATION" | "VALIDATION_ERROR"; rule?: string }> = {
  removalCreditNotRemovable: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-33" },
  inactiveServiceAdded: { code: "BUSINESS_RULE_VIOLATION", rule: "D-80" },
  itemServiceDuplicate: { code: "VALIDATION_ERROR" },
  itemQuantityFixed: { code: "VALIDATION_ERROR" },
  itemQuantityOutOfRange: { code: "VALIDATION_ERROR" },
};

/** Names for the audit snapshot and the checks: the venue's seasons and services. */
async function catalogContext(tx: Tx, venueId: string) {
  const [seasonRows, serviceRows] = await Promise.all([
    tx
      .select({ id: seasons.id, name: seasons.name, isActive: seasons.isActive })
      .from(seasons)
      .where(eq(seasons.venueId, venueId)),
    tx
      .select({
        id: services.id,
        name: services.name,
        pricingType: services.pricingType,
        isActive: services.isActive,
      })
      .from(services)
      .where(eq(services.venueId, venueId)),
  ]);
  return {
    seasons: new Map(seasonRows.map((s) => [s.id, s])),
    services: new Map(serviceRows.map((s) => [s.id, s])),
  };
}

type CatalogContext = Awaited<ReturnType<typeof catalogContext>>;

/** D-78 / D-80 / BR-30 / BR-33 against the stored set, before anything is written. */
function assertSets(fields: PackageFields, existing: Pick<PackageFields, "prices" | "items">, ctx: CatalogContext) {
  // Seasons and services of another venue simply do not exist here (T-05).
  if (fields.prices.some((p) => p.seasonId !== null && !ctx.seasons.has(p.seasonId))) throw notFound("seasonNotFound");
  if (fields.items.some((i) => !ctx.services.has(i.serviceId))) throw notFound("serviceNotFound");

  const priceViolation = priceSetViolation(fields.prices, {
    active: fields.isActive,
    inactiveSeasonIds: new Set([...ctx.seasons.values()].filter((s) => !s.isActive).map((s) => s.id)),
    existing: existing.prices,
  });
  if (priceViolation) {
    const { code, rule } = PRICE_RULES[priceViolation];
    throw new AppError(code, priceViolation, { rule, fieldErrors: { prices: priceViolation } });
  }
  const itemViolation = itemSetViolation(fields.items, {
    services: ctx.services,
    existingServiceIds: new Set(existing.items.map((i) => i.serviceId)),
  });
  if (itemViolation) {
    const { code, rule } = ITEM_RULES[itemViolation];
    throw new AppError(code, itemViolation, { rule, fieldErrors: { items: itemViolation } });
  }
}

const SLOT_ORDER = { day: 0, evening: 1, full_day: 2 } as const;

/** Readable before/after for the audit log: season and service names instead of ids. */
function snapshot(fields: PackageFields, ctx: CatalogContext) {
  return {
    name: fields.name,
    description: fields.description,
    baseGuests: fields.baseGuests,
    extraGuestPrice: fields.extraGuestPrice,
    isActive: fields.isActive,
    prices: [...fields.prices]
      .sort((a, b) => SLOT_ORDER[a.slotKind] - SLOT_ORDER[b.slotKind])
      .map((p) => ({
        slotKind: p.slotKind,
        season: p.seasonId === null ? null : (ctx.seasons.get(p.seasonId)?.name ?? p.seasonId),
        price: p.price,
      })),
    items: fields.items.map((i) => ({
      service: ctx.services.get(i.serviceId)?.name ?? i.serviceId,
      quantity: i.quantity,
      removable: i.removable,
      removalCredit: i.removalCredit,
    })),
  };
}

const priceKey = (p: Pick<PackagePrice, "slotKind" | "seasonId">) => `${p.slotKind}|${p.seasonId ?? ""}`;

/**
 * Writes the price and item sets (D-81): a price is identified by its slot and season, an
 * item by its service, so unchanged rows keep their ids; only removed rows are deleted.
 * These are package settings, not financial rows — bookings copy what they need (BR-37).
 */
async function syncChildren(tx: Tx, venueId: string, packageId: string, next: PackageFields) {
  const stored = await tx
    .select({
      id: packagePrices.id,
      slotKind: packagePrices.slotKind,
      seasonId: packagePrices.seasonId,
      price: packagePrices.price,
    })
    .from(packagePrices)
    .where(eq(packagePrices.packageId, packageId));
  const storedPrices = new Map(stored.map((p) => [priceKey(p), p]));
  const nextPrices = new Set(next.prices.map(priceKey));
  const removedPrices = stored.filter((p) => !nextPrices.has(priceKey(p))).map((p) => p.id);
  if (removedPrices.length > 0) await tx.delete(packagePrices).where(inArray(packagePrices.id, removedPrices));
  for (const p of next.prices) {
    const current = storedPrices.get(priceKey(p));
    if (!current) {
      await tx.insert(packagePrices).values({ venueId, packageId, ...p });
    } else if (current.price !== p.price) {
      await tx.update(packagePrices).set({ price: p.price }).where(eq(packagePrices.id, current.id));
    }
  }

  const storedItems = await tx
    .select({
      id: packageItems.id,
      serviceId: packageItems.serviceId,
      quantity: packageItems.quantity,
      removable: packageItems.removable,
      removalCredit: packageItems.removalCredit,
      sortOrder: packageItems.sortOrder,
    })
    .from(packageItems)
    .where(eq(packageItems.packageId, packageId));
  const byService = new Map(storedItems.map((i) => [i.serviceId, i]));
  const nextServices = new Set(next.items.map((i) => i.serviceId));
  const removedItems = storedItems.filter((i) => !nextServices.has(i.serviceId)).map((i) => i.id);
  if (removedItems.length > 0) await tx.delete(packageItems).where(inArray(packageItems.id, removedItems));
  // The items keep the order they were sent in (D-116).
  for (const [sortOrder, item] of next.items.entries()) {
    const current = byService.get(item.serviceId);
    if (!current) {
      await tx.insert(packageItems).values({ venueId, packageId, ...item, sortOrder });
    } else if (
      current.quantity !== item.quantity ||
      current.removable !== item.removable ||
      current.removalCredit !== item.removalCredit ||
      current.sortOrder !== sortOrder
    ) {
      const { quantity, removable, removalCredit } = item;
      await tx
        .update(packageItems)
        .set({ quantity, removable, removalCredit, sortOrder })
        .where(eq(packageItems.id, current.id));
    }
  }
}

/** The name index is per space (D-76), so the lookup is too. */
async function mapPackageNameConflict(error: unknown, db: DbOrTx, spaceId: string, name: string): Promise<never> {
  if (!isUniqueViolation(error, "packages_space_name_unique")) throw error;
  const [existing] = await db
    .select({ isActive: packages.isActive })
    .from(packages)
    .where(and(eq(packages.spaceId, spaceId), sql`lower(${packages.name}) = lower(${name})`));
  throw validationError({ name: existing && !existing.isActive ? "nameTakenInactive" : "nameTaken" });
}

const concurrentModification = () => new AppError("CONCURRENT_MODIFICATION", "packageModified");

export type CreatePackageInput = PackageFields & { spaceId: string };

/** D-77: a package is created on an active space of the venue, and stays on it. */
export async function createPackage(deps: ServiceDeps, actor: SessionUser, input: CreatePackageInput) {
  assertAllowed(actor, "catalog.manage");
  const { spaceId, ...fields } = input;
  return deps.db
    .transaction(async (tx) => {
      const [space] = await tx
        .select({ isActive: spaces.isActive })
        .from(spaces)
        .where(and(eq(spaces.id, spaceId), eq(spaces.venueId, actor.venueId)));
      if (!space) throw notFound("spaceNotFound");
      if (!space.isActive) {
        throw new AppError("BUSINESS_RULE_VIOLATION", "spaceInactiveForPackage", {
          rule: "BR-06",
          fieldErrors: { spaceId: "spaceInactiveForPackage" },
        });
      }
      const ctx = await catalogContext(tx, actor.venueId);
      assertSets(fields, { prices: [], items: [] }, ctx);
      const [row] = await tx
        .insert(packages)
        .values({
          venueId: actor.venueId,
          spaceId,
          name: fields.name,
          description: fields.description,
          baseGuests: fields.baseGuests,
          extraGuestPrice: fields.extraGuestPrice,
          isActive: fields.isActive,
        })
        .returning({ id: packages.id, version: packages.version });
      await syncChildren(tx, actor.venueId, row.id, fields);
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "packages.create",
        entityType: "package",
        entityId: row.id,
        after: { spaceId, ...snapshot(fields, ctx) },
      });
      return row;
    })
    .catch((e: unknown) => mapPackageNameConflict(e, deps.db, spaceId, input.name));
}

export type UpdatePackageInput = PackageFields & { packageId: string; version: number };

/**
 * Saves the package with its prices and items as one set (D-81). A version other than the
 * stored one means someone else saved since the page was opened: refused, nothing written.
 * New prices apply to bookings confirmed afterwards; confirmed ones keep their snapshot (D-15).
 */
export async function updatePackage(deps: ServiceDeps, actor: SessionUser, input: UpdatePackageInput) {
  assertAllowed(actor, "catalog.manage");
  const { packageId, version, ...fields } = input;
  let spaceId: string | undefined;
  return deps.db
    .transaction(async (tx) => {
      const before = await readPackage(tx, actor.venueId, packageId, true);
      spaceId = before.spaceId;
      if (before.version !== version) throw concurrentModification();
      const ctx = await catalogContext(tx, actor.venueId);
      assertSets(fields, before, ctx);
      await syncChildren(tx, actor.venueId, packageId, fields);
      const [row] = await tx
        .update(packages)
        .set({
          name: fields.name,
          description: fields.description,
          baseGuests: fields.baseGuests,
          extraGuestPrice: fields.extraGuestPrice,
          isActive: fields.isActive,
          version: before.version + 1,
        })
        .where(and(eq(packages.id, packageId), eq(packages.venueId, actor.venueId), eq(packages.version, version)))
        .returning({ version: packages.version });
      if (!row) throw concurrentModification();
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "packages.update",
        entityType: "package",
        entityId: packageId,
        before: snapshot(before, ctx),
        after: snapshot(fields, ctx),
        meta: { version: row.version },
      });
      return { version: row.version };
    })
    .catch((e: unknown) => (spaceId ? mapPackageNameConflict(e, deps.db, spaceId, input.name) : Promise.reject(e)));
}

/** Activation needs a regular price for at least one slot (BR-30, D-78); both bump the version (D-81). */
export async function setPackageActive(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { packageId: string; version: number; active: boolean },
) {
  assertAllowed(actor, "catalog.manage");
  return deps.db.transaction(async (tx) => {
    const before = await readPackage(tx, actor.venueId, input.packageId, true);
    if (before.version !== input.version) throw concurrentModification();
    if (before.isActive === input.active) return { version: before.version };
    if (input.active && bookableSlotKinds(before.prices).length === 0) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "activeWithoutRegularPrice", { rule: "BR-30" });
    }
    const [row] = await tx
      .update(packages)
      .set({ isActive: input.active, version: before.version + 1 })
      .where(and(eq(packages.id, input.packageId), eq(packages.venueId, actor.venueId)))
      .returning({ version: packages.version });
    const ctx = await catalogContext(tx, actor.venueId);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: input.active ? "packages.activate" : "packages.deactivate",
      entityType: "package",
      entityId: input.packageId,
      before: snapshot(before, ctx),
      after: snapshot({ ...before, isActive: input.active }, ctx),
      meta: { version: row.version },
    });
    return { version: row.version };
  });
}
