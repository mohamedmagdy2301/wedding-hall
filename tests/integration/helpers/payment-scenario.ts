import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { packagePrices } from "@/db/schema";
import { parsePounds } from "@/domain/money";
import { createRole } from "@/modules/users-rbac/roles";
import { bookingSpecs } from "@/server/specs/bookings";
import { settingsSpecs } from "@/server/specs/settings";
import { bookingScenario, NOW, ok } from "./booking-scenario";
import { addStaff, depsAt, signIn } from "./fixtures";

/**
 * PHASE6_PLAN §6.4: the phase 5 scenario made ready to confirm (BR-21 item 5) — venue phone
 * and address, two payment methods, a 25% minimum deposit and cancellation tiers — and a
 * wedding on 2027-03-15 at 20:00–01:00 in space A on the gold package for 200 guests:
 * 60,000 pounds.
 */

export const EVENT = "2027-03-15";

/** Pounds as written in the plan → piasters. */
export const p = (pounds: string) => {
  const piasters = parsePounds(pounds);
  if (piasters === null) throw new Error(`bad amount ${pounds}`);
  return piasters;
};

/** The plan's schedule I-01. */
export const I01 = [
  { dueDate: "2027-01-15", amount: "20,000" },
  { dueDate: "2027-03-14", amount: "25,000" },
];

export async function paymentScenario(handle: DbHandle, options: { policies?: boolean } = {}) {
  const s = await bookingScenario(handle);
  const { owner, call } = s;
  ok(
    await call(
      settingsSpecs.updateVenue,
      { name: "قاعة الاختبار", phone: "0223456789", address: "القاهرة" },
      owner.token,
    ),
  );
  const method = async (name: string) =>
    ok(await call(settingsSpecs.createListItem, { kind: "paymentMethods", name }, owner.token)).id as string;
  const cash = await method("كاش");
  const wallet = await method("فودافون كاش");
  if (options.policies !== false) {
    ok(
      await call(
        settingsSpecs.updatePolicies,
        {
          minDepositType: "percent",
          minDepositValue: "25",
          cancellationBasis: "deposit",
          postponeCreditMode: "refund",
          tiers: [
            { minDaysBefore: "30", refundBps: "50" },
            { minDaysBefore: "0", refundBps: "0" },
          ],
        },
        owner.token,
      ),
    );
  }

  /** A staff member whose only role has exactly these permissions. */
  const staffWith = async (login: string, permissionKeys: string[]) => {
    const role = await createRole(depsAt(handle, NOW), owner.actor, { name: `دور ${login}`, permissionKeys });
    const staff = await addStaff(handle, owner.actor, login, [role.id]);
    return signIn(handle, login, staff.password, NOW);
  };

  const weddingInput = (extra: Record<string, unknown> = {}) =>
    s.minimal({
      eventDate: EVENT,
      eventTypeId: s.wedding,
      groomName: "أحمد",
      brideName: "منى",
      packageId: s.gold,
      guests: "200",
      ...extra,
    });

  /** A complete tentative wedding: id, version and the quoted total. */
  const tentative = async (extra: Record<string, unknown> = {}) => {
    const created = ok(await call(bookingSpecs.createTentative, weddingInput(extra), s.reception.token));
    return { id: created.id as string, version: created.version as number, bookingNo: created.bookingNo as string };
  };

  const confirmInput = (
    booking: { id: string; version: number },
    deposit = "15,000",
    installments: { dueDate: string; amount: string }[] = I01,
    extra: Record<string, unknown> = {},
  ) => ({
    bookingId: booking.id,
    version: booking.version,
    expectedTotal: p("60,000"),
    deposit: { amount: deposit, methodId: cash },
    installments,
    ...extra,
  });

  /** A confirmed wedding with a 15,000 deposit and schedule I-01 (unless told otherwise). */
  const confirmed = async (
    deposit = "15,000",
    installments: { dueDate: string; amount: string }[] = I01,
    extra: Record<string, unknown> = {},
  ) => {
    const booking = await tentative(extra);
    const result = ok(
      await call(bookingSpecs.confirm, confirmInput(booking, deposit, installments), s.reception.token),
    );
    return {
      ...booking,
      version: result.version as number,
      depositId: result.paymentId as string,
      receiptNo: result.receiptNo as string,
    };
  };

  /** Changes the gold package's regular evening price behind the booking's back (CF-05). */
  const setEveningPrice = (pounds: string) =>
    handle.db
      .update(packagePrices)
      .set({ price: p(pounds) })
      .where(
        and(eq(packagePrices.packageId, s.gold), eq(packagePrices.slotKind, "evening"), isNull(packagePrices.seasonId)),
      );

  return { ...s, cash, wallet, staffWith, weddingInput, tentative, confirmInput, confirmed, setEveningPrice };
}

export type PaymentScenario = Awaited<ReturnType<typeof paymentScenario>>;
