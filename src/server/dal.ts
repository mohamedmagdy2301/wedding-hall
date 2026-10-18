import "server-only";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/db/request";
import { listAudit, listAuditActors, type AuditFilters } from "@/modules/audit/service";
import { calendar } from "@/modules/bookings/availability";
import {
  getBooking,
  getBookingFormOptions,
  getTentativeForEdit,
  listBookings,
  listSpaceNames,
} from "@/modules/bookings/queries";
import type { BookingListFilters, CalendarInput } from "@/modules/bookings/schemas";
import { listServices } from "@/modules/catalog/services";
import { getCustomer, listCustomers } from "@/modules/customers/service";
import { getNewPackageOptions, getPackage, listPackages } from "@/modules/packages/service";
import { resolveSession, type SessionUser } from "@/modules/auth/sessions";
import { getSetupChecklist } from "@/modules/settings/checklist";
import { listItems } from "@/modules/settings/lists";
import { getVenueSummary } from "@/modules/settings/repository";
import type { ListKind } from "@/modules/settings/schemas";
import { listSeasons } from "@/modules/settings/seasons";
import { getTiming, getVenueSettings } from "@/modules/settings/venue";
import { listSpaces } from "@/modules/spaces/service";
import { satisfies, type Requirement } from "@/modules/users-rbac/authorize";
import { listRoles } from "@/modules/users-rbac/roles";
import { listUsers } from "@/modules/users-rbac/users";
import { AppError } from "@/modules/shared/errors";
import { id as uuidField } from "@/modules/shared/fields";
import { readSessionToken } from "./session-cookie";

/**
 * Data access layer (P1-08). Every page and every data function below checks the session
 * against the database itself; layouts only add an early redirect, because they do not
 * re-run on client navigation. `cache` dedupes the check within one render.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  // Per-request data: never prerendered at build time.
  await connection();
  const token = await readSessionToken();
  return resolveSession(getDb(), token, new Date());
});

export async function requireUser(options: { allowPendingPasswordChange?: boolean } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !options.allowPendingPasswordChange) redirect("/change-password");
  return user;
}

export async function requireAccess(requirement: Requirement): Promise<SessionUser> {
  const user = await requireUser();
  if (!satisfies(user, requirement)) redirect("/forbidden");
  return user;
}

/** For screens open to any of several permissions (the settings shell). */
export async function requireAnyAccess(requirements: Requirement[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!requirements.some((r) => satisfies(user, r))) redirect("/forbidden");
  return user;
}

/** What the client may know about the current user (DTO: no session id, no secrets). */
export type CurrentUserView = {
  name: string;
  login: string;
  isOwner: boolean;
  permissions: string[];
};

export function toView(user: SessionUser): CurrentUserView {
  return { name: user.name, login: user.login, isOwner: user.isOwner, permissions: [...user.permissions] };
}

export async function getShellData() {
  const user = await requireUser();
  const venue = await getVenueSummary(getDb());
  return { user: toView(user), venueName: venue?.name ?? "" };
}

export async function getStaffPageData() {
  const actor = await requireAccess("users.manage");
  const db = getDb();
  const [users, roles] = await Promise.all([listUsers(db, actor), listRoles(db, actor)]);
  return { me: { ...toView(actor), id: actor.userId }, users, roles };
}

export async function getAuditPageData(filters: AuditFilters) {
  const actor = await requireAccess("audit.view");
  const db = getDb();
  const [result, actors] = await Promise.all([listAudit(db, actor, filters), listAuditActors(db, actor)]);
  return { ...result, actors };
}

/** S-13 tabs. Each checks its own permission (D-66: spaces and seasons are `catalog.manage`). */
export async function getVenueSettingsPageData() {
  const actor = await requireAccess("settings.manage");
  return getVenueSettings(getDb(), actor);
}

export async function getSpacesPageData() {
  const actor = await requireAccess("catalog.manage");
  const db = getDb();
  const [spaces, timing] = await Promise.all([listSpaces(db, actor), getTiming(db, actor.venueId)]);
  return { spaces, bufferMinutes: timing.bufferMinutes };
}

export async function getSeasonsPageData() {
  const actor = await requireAccess("catalog.manage");
  return { seasons: await listSeasons(getDb(), actor) };
}

export async function getServicesPageData() {
  const actor = await requireAccess("catalog.manage");
  return { services: await listServices(getDb(), actor) };
}

export async function getPackagesPageData() {
  const actor = await requireAccess("catalog.manage");
  return { packages: await listPackages(getDb(), actor) };
}

export async function getNewPackagePageData() {
  const actor = await requireAccess("catalog.manage");
  return getNewPackageOptions(getDb(), actor);
}

/** The package edit page, opened on the current `version` (D-81). Unknown ids are a 404. */
export async function getPackagePageData(packageId: string) {
  const actor = await requireAccess("catalog.manage");
  if (!uuidField.safeParse(packageId).success) notFound();
  try {
    return await getPackage(getDb(), actor, packageId);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

export async function getListPageData(kind: ListKind) {
  const actor = await requireAccess("settings.manage");
  return { items: await listItems(getDb(), actor, kind) };
}

/** S-14 (owner). */
export async function getSetupPageData() {
  const actor = await requireAccess("owner");
  const db = getDb();
  const [checklist, timing] = await Promise.all([getSetupChecklist(db, actor), getTiming(db, actor.venueId)]);
  return { ...checklist, timing };
}

/** The home card: shown to owners while the guided setup is incomplete (S-14). */
export async function getHomeSetupCard() {
  const actor = await requireUser();
  if (!actor.isOwner) return null;
  const { steps, complete } = await getSetupChecklist(getDb(), actor);
  if (complete) return null;
  const counted = steps.filter((s) => s.required);
  return { done: counted.filter((s) => s.status === "done").length, total: counted.length };
}

/** S-06 new booking (`bookings.create`). The live price and availability need `bookings.view` too. */
export async function getNewBookingPageData() {
  const actor = await requireAccess("bookings.create");
  return { options: await getBookingFormOptions(getDb(), actor), canView: satisfies(actor, "bookings.view") };
}

async function orNotFound<T>(id: string, read: () => Promise<T>): Promise<T> {
  if (!uuidField.safeParse(id).success) notFound();
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

/** S-06 editing a tentative booking (`bookings.edit`, D-101); any other status goes back to its page. */
export async function getEditBookingPageData(bookingId: string) {
  const actor = await requireAccess("bookings.edit");
  const db = getDb();
  const booking = await orNotFound(bookingId, () => getTentativeForEdit(db, actor, bookingId));
  if (booking.status !== "tentative") redirect(`/bookings/${bookingId}`);
  return { booking, options: await getBookingFormOptions(db, actor), canView: satisfies(actor, "bookings.view") };
}

/** S-07 (`bookings.view`). */
export async function getBookingPageData(bookingId: string) {
  const actor = await requireAccess("bookings.view");
  const db = getDb();
  const data = await orNotFound(bookingId, () => getBooking(db, actor, bookingId, new Date()));
  const timing = await getTiming(db, actor.venueId);
  return { ...data, canEdit: satisfies(actor, "bookings.edit"), holdHours: timing.tentativeHoldHours };
}

/** S-05 (`bookings.view`). */
export async function getBookingsPageData(filters: BookingListFilters) {
  const actor = await requireAccess("bookings.view");
  const db = getDb();
  const [result, spaces] = await Promise.all([listBookings(db, actor, filters, new Date()), listSpaceNames(db, actor)]);
  return { ...result, spaces, canCreate: satisfies(actor, "bookings.create") };
}

/** S-04 (`bookings.view`). */
export async function getCalendarPageData(input: CalendarInput) {
  const actor = await requireAccess("bookings.view");
  const data = await calendar(getDb(), actor, input, new Date());
  return { ...data, canCreate: satisfies(actor, "bookings.create") };
}

/** S-08 list (`bookings.view`; adding and editing need `customers.manage`). */
export async function getCustomersPageData(input: { search: string; page: number }) {
  const actor = await requireAccess("bookings.view");
  return { ...(await listCustomers(getDb(), actor, input)), canManage: satisfies(actor, "customers.manage") };
}

/** S-08 customer page. */
export async function getCustomerPageData(customerId: string) {
  const actor = await requireAccess("bookings.view");
  const data = await orNotFound(customerId, () => getCustomer(getDb(), actor, customerId, new Date()));
  return { ...data, canManage: satisfies(actor, "customers.manage") };
}
