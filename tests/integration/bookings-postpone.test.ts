import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookingChanges, bookings, installments, packagePrices, packages, payments } from "@/db/schema";
import { cairoDate } from "@/lib/time";
import { bookingSpecs } from "@/server/specs/bookings";
import { discountSpecs } from "@/server/specs/discounts";
import { paymentSpecs } from "@/server/specs/payments";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { failed, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { OWNER, signIn } from "./helpers/fixtures";
import { EVENT, p, paymentScenario, type PaymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE8_PLAN §4.2 through the action pipeline (BR-80..85, D-94, Q8-06) on the phase 6
 * wedding: 2027-03-15 evening, gold package (evening 60,000, day 40,000, summer evening
 * 75,000) for 200 guests — 60,000, deposit 15,000, schedule 20,000 (01-15) + 25,000 (03-14).
 */

describe("postponement (BR-80..85)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  type Target = { eventDate: string; slotKind: "day" | "evening" | "full_day" };
  const SUMMER: Target = { eventDate: "2027-07-15", slotKind: "evening" };
  const APRIL_DAY: Target = { eventDate: "2027-04-10", slotKind: "day" };

  const previewOf = (s: PaymentScenario, bookingId: string, target: Target, token = s.reception.token) =>
    s.call(bookingSpecs.postponePreview, { bookingId, ...target }, token);

  /** Previews, then postpones with the previewed total. */
  const postpone = async (
    s: PaymentScenario,
    booking: { id: string },
    target: Target,
    extra: Record<string, unknown> = {},
    token = s.reception.token,
  ) => {
    const preview = ok(await previewOf(s, booking.id, target, token));
    return s.call(
      bookingSpecs.postpone,
      { bookingId: booking.id, version: preview.version, expectedTotal: preview.totalAfter, ...target, ...extra },
      token,
    );
  };

  const row = async (bookingId: string) => (await db.select().from(bookings).where(eq(bookings.id, bookingId)))[0];
  const schedule = async (bookingId: string) =>
    (
      await db.select().from(installments).where(eq(installments.bookingId, bookingId)).orderBy(installments.dueDate)
    ).map((l) => [l.dueDate, l.amount]);

  it("PP-01: to a summer evening — only the base price and season change (BR-81), the schedule follows, the change is recorded (BR-85)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const before = await row(a.id);
    const preview = ok(await previewOf(s, a.id, SUMMER));
    expect(preview).toMatchObject({
      basePriceBefore: p("60,000"),
      basePriceAfter: p("75,000"),
      seasonName: "الصيف",
      totalBefore: p("60,000"),
      totalAfter: p("75,000"),
      credit: 0,
      lateInstallments: [],
      confirmedConflicts: [],
    });
    const result = ok(await postpone(s, a, SUMMER));
    expect(result).toMatchObject({ total: p("75,000"), credit: 0, refund: null });
    const after = await row(a.id);
    expect(cairoDate(after.startsAt)).toBe("2027-07-15");
    expect(after).toMatchObject({
      basePrice: p("75,000"),
      total: p("75,000"),
      extraGuestsAmount: before.extraGuestsAmount,
      itemsTotal: before.itemsTotal,
      removalCreditsTotal: before.removalCreditsTotal,
      version: preview.version + 1,
      // D-68: the policy fixed at confirmation stays.
      cancellationTiers: before.cancellationTiers,
      cancellationBasis: before.cancellationBasis,
    });
    expect(after.seasonId).not.toBeNull();
    expect(after.blockedUntil.getTime() - after.endsAt.getTime()).toBe(60 * 60_000);
    expect(await schedule(a.id)).toEqual([
      ["2027-01-15", p("20,000")],
      ["2027-03-14", p("40,000")],
    ]);
    const [change] = await db.select().from(bookingChanges).where(eq(bookingChanges.bookingId, a.id));
    expect(change).toMatchObject({ kind: "postpone", totalBefore: p("60,000"), totalAfter: p("75,000") });
    expect(change.before).toMatchObject({ basePrice: p("60,000"), seasonId: null });
    expect(change.after).toMatchObject({ basePrice: p("75,000"), seasonId: after.seasonId });
    const page = ok(await s.call(bookingSpecs.get, { bookingId: a.id }));
    expect(page.history.map((h: { action: string }) => h.action)).toContain("bookings.postpone");
  });

  it("PP-02: to a day slot in April — 40,000, the last installment drops to 5,000, no credit", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const result = ok(await postpone(s, a, APRIL_DAY));
    expect(result).toMatchObject({ total: p("40,000"), credit: 0 });
    expect(await schedule(a.id)).toEqual([
      ["2027-01-15", p("20,000")],
      ["2027-03-14", p("5,000")],
    ]);
  });

  it("PP-03: fully paid, to a cheaper slot — a 20,000 credit settled by the policy (BR-83, D-131)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    ok(await s.call(paymentSpecs.record, { bookingId: a.id, amount: "45,000", methodId: s.cash }));
    const preview = ok(await previewOf(s, a.id, APRIL_DAY, s.manager.token));
    expect(preview).toMatchObject({ credit: p("20,000"), creditMode: "refund" });
    expect(failed(await postpone(s, a, APRIL_DAY, {}, s.manager.token)).fieldErrors).toHaveProperty("credit.methodId");
    // Reception lacks payments.refund: the whole postponement is refused.
    expect(failed(await postpone(s, a, APRIL_DAY, { credit: { resolution: "refund", methodId: s.cash } })).code).toBe(
      "FORBIDDEN",
    );
    const result = ok(
      await postpone(s, a, APRIL_DAY, { credit: { resolution: "refund", methodId: s.cash } }, s.manager.token),
    );
    expect(result).toMatchObject({ credit: p("20,000"), creditResolution: "refund" });
    expect(result.refund).toMatchObject({ amount: p("20,000") });
    const ledger = ok(await s.call(bookingSpecs.get, { bookingId: a.id })).money.ledger;
    expect(ledger).toMatchObject({ paid: p("40,000"), remaining: 0 });
  });

  it("PP-03: under the services policy the credit stays (remaining −20,000); under both the staff member chooses", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed("15,000", []);
    ok(await s.call(paymentSpecs.record, { bookingId: a.id, amount: "45,000", methodId: s.cash }));
    const setMode = (postponeCreditMode: string) =>
      s.call(
        settingsSpecs.updatePolicies,
        {
          minDepositType: "percent",
          minDepositValue: "25",
          cancellationBasis: "deposit",
          postponeCreditMode,
          tiers: [{ minDaysBefore: "0", refundBps: "0" }],
          confirmNoRefund: true,
        },
        s.owner.token,
      );
    ok(await setMode("both"));
    expect(failed(await postpone(s, a, APRIL_DAY)).rule).toBe("BR-83");
    ok(await setMode("services"));
    expect(ok(await postpone(s, a, APRIL_DAY))).toMatchObject({ credit: p("20,000"), creditResolution: "services" });
    const ledger = ok(await s.call(bookingSpecs.get, { bookingId: a.id })).money.ledger;
    expect(ledger).toMatchObject({ paid: p("60,000"), remaining: -p("20,000") });
  });

  it("PP-04: a slot taken by a confirmed booking is refused (BR-11); the preview names it", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const other = await s.confirmed("15,000", [], { eventDate: "2027-04-10" });
    const target: Target = { eventDate: "2027-04-10", slotKind: "evening" };
    const preview = ok(await previewOf(s, a.id, target));
    expect(preview.confirmedConflicts).toEqual([{ id: other.id, bookingNo: other.bookingNo }]);
    const result = await s.call(bookingSpecs.postpone, {
      bookingId: a.id,
      version: preview.version,
      expectedTotal: preview.totalAfter,
      ...target,
    });
    expect(failed(result)).toMatchObject({ code: "CONFLICT_SLOT_TAKEN", rule: "BR-11" });
    expect(cairoDate((await row(a.id)).startsAt)).toBe(EVENT);
  });

  it("PP-05: an inactive space is refused (BR-06); a slot without a regular package price too (D-56)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    await db
      .delete(packagePrices)
      .where(
        and(eq(packagePrices.packageId, s.gold), eq(packagePrices.slotKind, "day"), isNull(packagePrices.seasonId)),
      );
    expect(failed(await previewOf(s, a.id, APRIL_DAY)).rule).toBe("D-56");
    ok(await s.call(spaceSpecs.setSpaceActive, { spaceId: s.spaceA, active: false }, s.manager.token));
    expect(failed(await previewOf(s, a.id, SUMMER)).rule).toBe("BR-06");
  });

  it("PP-06: installments after the new eve must be moved first (BR-84); with a schedule sent it goes through", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const target: Target = { eventDate: "2027-02-10", slotKind: "evening" };
    const preview = ok(await previewOf(s, a.id, target));
    expect(preview.lateInstallments).toEqual([{ dueDate: "2027-03-14", amount: p("25,000") }]);
    expect(preview.suggestedInstallments).toEqual([
      { dueDate: "2027-01-15", amount: p("20,000") },
      { dueDate: "2027-02-09", amount: p("25,000") },
    ]);
    expect(failed(await postpone(s, a, target))).toMatchObject({ rule: "BR-84" });
    ok(
      await postpone(s, a, target, {
        installments: [
          { dueDate: "2027-01-15", amount: "20,000" },
          { dueDate: "2027-02-09", amount: "25,000" },
        ],
      }),
    );
    expect(await schedule(a.id)).toEqual([
      ["2027-01-15", p("20,000")],
      ["2027-02-09", p("25,000")],
    ]);
    expect((await row(a.id)).total).toBe(p("60,000"));
  });

  it("PP-07: the catalog's price now for the new slot (BR-81) — the regular evening raised to 65,000", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    await s.setEveningPrice("65,000");
    expect(ok(await postpone(s, a, { eventDate: "2027-04-10", slotKind: "evening" })).total).toBe(p("65,000"));
  });

  it("PP-08: an approved discount stays — 2,000 off, to summer: 73,000", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    ok(await s.call(discountSpecs.request, { bookingId: a.id, amount: "2,000", reason: "عميل قديم" }, s.manager.token));
    expect(ok(await postpone(s, a, SUMMER)).total).toBe(p("73,000"));
  });

  it("PP-09: extra guests keep the price on the booking (D-94) — 230 guests, the package's extra price raised", async () => {
    const s = await paymentScenario(handle);
    const t = await s.tentative({ guests: "230" });
    const confirmed = ok(
      await s.call(
        bookingSpecs.confirm,
        { ...s.confirmInput(t, "16,125", []), expectedTotal: p("64,500") },
        s.reception.token,
      ),
    );
    await db
      .update(packages)
      .set({ extraGuestPrice: p("180") })
      .where(eq(packages.id, s.gold));
    const result = ok(await postpone(s, { id: t.id }, SUMMER));
    expect(confirmed.total).toBe(p("64,500"));
    expect(result.total).toBe(p("79,500"));
    expect((await row(t.id)).extraGuestsAmount).toBe(p("4,500"));
  });

  it("PP-10: tentative, cancelled and finished bookings are not postponed (BR-80)", async () => {
    const s = await paymentScenario(handle);
    const t = await s.tentative({ eventDate: "2027-05-01" });
    expect(failed(await previewOf(s, t.id, SUMMER)).rule).toBe("BR-80");
    const a = await s.confirmed();
    const later = new Date("2027-03-16T10:00:00Z");
    const owner = await signIn(handle, OWNER.login, OWNER.password, later);
    expect(
      failed(await s.call(bookingSpecs.postponePreview, { bookingId: a.id, ...SUMMER }, owner.token, later)).rule,
    ).toBe("BR-80");
    ok(await s.call(bookingSpecs.cancel, { bookingId: t.id, version: t.version, reason: "اعتذر" }));
    expect(failed(await previewOf(s, t.id, SUMMER)).rule).toBe("BR-80");
  });

  it("PP-11 / Q8-01: after a postponement the cancellation counts days to the new date", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    ok(await postpone(s, a, SUMMER));
    const q = ok(await s.call(bookingSpecs.cancelPreview, { bookingId: a.id }, s.manager.token));
    // 2026-10-18 → 2027-07-15; the snapshot's tiers are 30 → 50%, 0 → 0%.
    expect(q).toMatchObject({ daysRemaining: 270, refundBps: 5000, suggested: p("7,500") });
  });

  it("a total other than the one previewed is refused (PRICE_CHANGED), and so is the same slot (nothing changed)", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    const preview = ok(await previewOf(s, a.id, SUMMER));
    await db
      .update(packagePrices)
      .set({ price: p("80,000") })
      .where(eq(packagePrices.seasonId, s.summer));
    const result = await s.call(bookingSpecs.postpone, {
      bookingId: a.id,
      version: preview.version,
      expectedTotal: preview.totalAfter,
      ...SUMMER,
    });
    expect(failed(result).code).toBe("PRICE_CHANGED");
    expect(failed(await previewOf(s, a.id, { eventDate: EVENT, slotKind: "evening" })).code).toBe("VALIDATION_ERROR");
    expect((await db.select().from(payments).where(eq(payments.bookingId, a.id))).length).toBe(1);
  });

  it("the accountant (no bookings.postpone) is refused", async () => {
    const s = await paymentScenario(handle);
    const a = await s.confirmed();
    expect(failed(await previewOf(s, a.id, SUMMER, s.accountant.token)).code).toBe("FORBIDDEN");
  });
});
