import type { z } from "zod";
import type { DbHandle } from "@/db/client";
import { catalogSpecs } from "@/server/specs/catalog";
import { bookingSpecs } from "@/server/specs/bookings";
import type { ProtectedSpec } from "@/server/specs/define";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { SLOTS } from "./bookings";
import { addStaff, callSpec, OWNER, setUpVenueWithOwner, signIn } from "./fixtures";

/**
 * The phase 5 booking scenario (PHASE5_PLAN §9.5) shared by the bookings*.test.ts files: a
 * venue with staff of each default role, two spaces, a season, services and two packages,
 * driven through the real action pipeline. The clock is fixed at 2026-10-18 13:00 Cairo so
 * the date window (BR-27) and the numbering year never drift.
 */

export type AnySpec = ProtectedSpec<z.ZodType, unknown>;
export type Failure = {
  code: string;
  message?: string;
  rule?: string;
  fieldErrors?: Record<string, string>;
  details?: Record<string, unknown>;
};
export type Result = { ok: true; data: any } | { ok: false; error: Failure }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const NOW = new Date("2026-10-18T10:00:00Z");
export const HOUR = 3_600_000;

export const ok = (result: Result) => {
  if (!result.ok)
    throw new Error(
      `${result.error.code} ${result.error.rule ?? ""} ${JSON.stringify(result.error.fieldErrors ?? {})}`,
    );
  return result.data;
};
export const failed = (result: Result) => {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
};

export async function bookingScenario(handle: DbHandle) {
  const base = await setUpVenueWithOwner(handle);
  const staff = async (login: string, role: string) => {
    const s = await addStaff(handle, base.owner.actor, login, [base.roleId(role)]);
    return signIn(handle, login, s.password, NOW);
  };
  const owner = await signIn(handle, OWNER.login, OWNER.password, NOW);
  const manager = await staff("manager", "مدير");
  const reception = await staff("reception", "استقبال/حجوزات");
  const accountant = await staff("accountant", "محاسب");
  // `null` = no session (an explicit `undefined` would take the default token).
  const call = (spec: unknown, input: unknown, token: string | null = reception.token, now = NOW) =>
    callSpec(handle, spec as AnySpec, token ?? undefined, input, now) as Promise<Result>;

  ok(await call(settingsSpecs.updateTiming, { bufferMinutes: "60", tentativeHoldHours: "48" }, owner.token));
  const spaceA = ok(
    await call(spaceSpecs.createSpace, { name: "القاعة الكبرى", capacityMax: "300", ...SLOTS }, manager.token),
  ).id as string;
  const spaceB = ok(await call(spaceSpecs.createSpace, { name: "الروف", capacityMax: "", ...SLOTS }, manager.token))
    .id as string;
  const wedding = ok(
    await call(settingsSpecs.createListItem, { kind: "eventTypes", name: "فرح", isWedding: true }, owner.token),
  ).id as string;
  const summer = ok(
    await call(
      settingsSpecs.createSeason,
      { name: "الصيف", startDate: "2027-06-01", endDate: "2027-09-30" },
      manager.token,
    ),
  ).id as string;

  const service = async (name: string, pricingType: string, unitPrice: string, externalFee: string | null = null) =>
    ok(
      await call(
        catalogSpecs.createService,
        {
          name,
          category: "service",
          pricingType,
          unitPrice,
          allowExternal: externalFee !== null,
          externalFee: externalFee ?? "",
        },
        manager.token,
      ),
    ).id as string;
  const S = {
    DJ: await service("دي جي", "fixed", "5000", "1000"),
    PHOTO: await service("تصوير", "per_unit", "2500", ""),
    BUFFET: await service("بوفيه عشاء", "per_guest", "180"),
    ZAFFA: await service("زفة", "fixed", "3000"),
    WELCOME: await service("مشروب ترحيب", "per_guest", "25.50"),
    BAND: await service("فرقة", "per_unit", "4000", "1500"),
  };
  const gold = ok(
    await call(
      catalogSpecs.createPackage,
      {
        spaceId: spaceA,
        name: "الذهبي",
        description: "",
        baseGuests: "200",
        extraGuestPrice: "150",
        isActive: true,
        prices: [
          { slotKind: "day", seasonId: null, price: "40000" },
          { slotKind: "evening", seasonId: null, price: "60000" },
          { slotKind: "full_day", seasonId: null, price: "90000" },
          { slotKind: "evening", seasonId: summer, price: "75000" },
        ],
        items: [
          { serviceId: S.DJ, quantity: "1", removable: true, removalCredit: "3000" },
          { serviceId: S.PHOTO, quantity: "2", removable: true, removalCredit: "2000" },
          { serviceId: S.ZAFFA, quantity: "1", removable: false, removalCredit: "" },
          { serviceId: S.WELCOME, quantity: "1", removable: true, removalCredit: "4000" },
        ],
      },
      manager.token,
    ),
  ).id as string;
  const roof = ok(
    await call(
      catalogSpecs.createPackage,
      {
        spaceId: spaceB,
        name: "الروف",
        description: "",
        baseGuests: "50",
        extraGuestPrice: "100",
        isActive: true,
        prices: [{ slotKind: "evening", seasonId: null, price: "10000" }],
        items: [],
      },
      manager.token,
    ),
  ).id as string;

  const minimal = (extra: Record<string, unknown> = {}) => ({
    spaceId: spaceA,
    eventDate: "2027-01-15",
    slotKind: "evening",
    customer: { name: "محمد علي", phone: "0100 123 4567" },
    ...extra,
  });
  const create = async (extra: Record<string, unknown> = {}, token?: string, now?: Date) =>
    ok(await call(bookingSpecs.createTentative, minimal(extra), token, now));

  return {
    ...base,
    owner,
    manager,
    reception,
    accountant,
    call,
    spaceA,
    spaceB,
    wedding,
    summer,
    S,
    gold,
    roof,
    minimal,
    create,
  };
}
