import { and, asc, count, desc, eq, ilike, like, or, sql, type SQL } from "drizzle-orm";
import { bookings, customers, spaces } from "@/db/schema";
import { displayStatus } from "@/domain/booking-status";
import { toAsciiDigits } from "@/lib/digits";
import { recordAudit } from "@/modules/audit/service";
import { normalizeEgyptianMobile } from "@/modules/auth/login-id";
import type { SessionUser } from "@/modules/auth/sessions";
import { overlapsConfirmedSql } from "@/modules/bookings/repository";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { notFound } from "@/modules/shared/errors";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import type { CustomerFields } from "./schemas";

/**
 * Customers (D-28, D-52, D-106). Phones are not unique: an existing number is suggested and
 * staff choose to link or create (D-28). Reading is `bookings.view`, the wizard's
 * suggestion `bookings.create`, adding and editing from S-08 `customers.manage`. Never
 * deleted (D-107).
 */

export const CUSTOMERS_PAGE_SIZE = 50;

const columns = {
  id: customers.id,
  name: customers.name,
  phone: customers.phone,
  altPhone: customers.altPhone,
  notes: customers.notes,
};

// Qualified by hand: drizzle renders a column of a single-table select without its table.
const bookingCount = sql<number>`(SELECT count(*)::int FROM bookings b WHERE b.customer_id = "customers"."id")`;

export type Customer = { id: string; name: string; phone: string; altPhone: string | null; notes: string | null };

const snapshot = (c: CustomerFields) => ({ name: c.name, phone: c.phone, altPhone: c.altPhone, notes: c.notes });

/** `%` and `_` typed by the user are literal characters in a LIKE pattern. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A mobile matches the phone or the second phone; other digits match part of either; text matches the name. */
function searchCondition(search: string): SQL | undefined {
  const text = search.trim();
  if (!text) return undefined;
  const phone = normalizeEgyptianMobile(text);
  if (phone) return or(eq(customers.phone, phone), eq(customers.altPhone, phone));
  const digits = toAsciiDigits(text).replace(/[\s\-()+]/g, "");
  if (/^\d{3,}$/.test(digits)) {
    return or(like(customers.phone, `%${digits}%`), like(customers.altPhone, `%${digits}%`));
  }
  return ilike(customers.name, `%${likeEscape(text)}%`);
}

/** D-28: customers whose phone or second phone is this number, for the wizard's suggestion. */
export async function lookupByPhone(db: DbOrTx, actor: SessionUser, input: { phone: string }) {
  assertAllowed(actor, "bookings.create");
  return db
    .select({ ...columns, bookingCount })
    .from(customers)
    .where(
      and(
        eq(customers.venueId, actor.venueId),
        or(eq(customers.phone, input.phone), eq(customers.altPhone, input.phone)),
      ),
    )
    .orderBy(asc(customers.name))
    .limit(10);
}

/** S-08 list with search. */
export async function listCustomers(db: DbOrTx, actor: SessionUser, input: { search: string; page: number }) {
  assertAllowed(actor, "bookings.view");
  const where = and(eq(customers.venueId, actor.venueId), searchCondition(input.search));
  const page = Math.max(1, input.page);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...columns, bookingCount })
      .from(customers)
      .where(where)
      .orderBy(asc(customers.name), asc(customers.id))
      .limit(CUSTOMERS_PAGE_SIZE)
      .offset((page - 1) * CUSTOMERS_PAGE_SIZE),
    db.select({ total: count() }).from(customers).where(where),
  ]);
  return { rows, total, page, pageSize: CUSTOMERS_PAGE_SIZE };
}

export async function readCustomer(db: DbOrTx, venueId: string, customerId: string): Promise<Customer> {
  const [row] = await db
    .select(columns)
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.venueId, venueId)));
  if (!row) throw notFound("customerNotFound");
  return row;
}

/** S-08 customer page: the customer and their bookings with the status shown now. */
export async function getCustomer(db: DbOrTx, actor: SessionUser, customerId: string, now: Date) {
  assertAllowed(actor, "bookings.view");
  const customer = await readCustomer(db, actor.venueId, customerId);
  const rows = await db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      spaceName: spaces.name,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      tentativeExpiresAt: bookings.tentativeExpiresAt,
      total: bookings.total,
      overlapsConfirmed: overlapsConfirmedSql,
    })
    .from(bookings)
    .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
    .where(and(eq(bookings.venueId, actor.venueId), eq(bookings.customerId, customerId)))
    .orderBy(desc(bookings.startsAt));
  return {
    customer,
    bookings: rows.map(({ overlapsConfirmed, ...b }) => ({
      ...b,
      displayStatus: displayStatus(b, now, overlapsConfirmed),
    })),
  };
}

/** Adds a customer inside the caller's transaction, with its audit row (the wizard and S-08). */
export async function insertCustomer(tx: Tx, venueId: string, actorId: string, fields: CustomerFields) {
  const [row] = await tx
    .insert(customers)
    .values({ venueId, ...snapshot(fields) })
    .returning({ id: customers.id });
  await recordAudit(tx, {
    venueId,
    actorId,
    action: "customers.create",
    entityType: "customer",
    entityId: row.id,
    after: snapshot(fields),
  });
  return row.id;
}

export async function createCustomer(deps: ServiceDeps, actor: SessionUser, input: CustomerFields) {
  assertAllowed(actor, "customers.manage");
  const id = await deps.db.transaction((tx) => insertCustomer(tx, actor.venueId, actor.userId, input));
  return { id };
}

export async function updateCustomer(
  deps: ServiceDeps,
  actor: SessionUser,
  input: CustomerFields & { customerId: string },
) {
  assertAllowed(actor, "customers.manage");
  await deps.db.transaction(async (tx) => {
    const [before] = await tx
      .select(columns)
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.venueId, actor.venueId)))
      .for("update");
    if (!before) throw notFound("customerNotFound");
    await tx
      .update(customers)
      .set(snapshot(input))
      .where(and(eq(customers.id, input.customerId), eq(customers.venueId, actor.venueId)));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "customers.update",
      entityType: "customer",
      entityId: input.customerId,
      before: snapshot(before),
      after: snapshot(input),
    });
  });
}
