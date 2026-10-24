import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  bookingChanges,
  bookingItems,
  bookings,
  discountRequests,
  installments,
  packageItems,
  packages,
  services,
  venues,
} from "@/db/schema";
import { bookingSpecs } from "@/server/specs/bookings";
import { catalogSpecs } from "@/server/specs/catalog";
import { paymentSpecs } from "@/server/specs/payments";
import { failed, NOW, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { OWNER, signIn } from "./helpers/fixtures";
import { pgErrorCode } from "./helpers/pg-error";
import { p, paymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE7_PLAN §4.2–§4.3 through the action pipeline (BR-40..43, D-92, D-93, Q7-04..Q7-07,
 * D-128): a wedding on the gold package for 200 guests (60,000) with a kosha (fixed 4,000)
 * and a drink per guest (20 × 200 = 4,000): 68,000; deposit 17,000 (the 25% minimum) and
 * the schedule 20,000 + 31,000. Then the catalog moves: extra guest 180, drink 25.
 */

describe("editing a confirmed booking (BR-40..43, D-92, D-93, D-128)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const SCHEDULE = [
    { dueDate: "2027-01-15", amount: "20,000" },
    { dueDate: "2027-03-14", amount: "31,000" },
  ];

  async function scenario(policy: "refund" | "services" | "both" = "refund") {
    const s = await paymentScenario(handle);
    const service = async (name: string, pricingType: string, unitPrice: string) =>
      ok(
        await s.call(
          catalogSpecs.createService,
          { name, category: "service", pricingType, unitPrice, allowExternal: false, externalFee: "" },
          s.manager.token,
        ),
      ).id as string;
    const kosha = await service("كوشة", "fixed", "4000");
    const drink = await service("مشروب", "per_guest", "20");
    await db.update(venues).set({ postponeCreditMode: policy }).where(eq(venues.id, s.venueId));
    const items = [
      { serviceId: kosha, quantity: "1", isExternal: false },
      { serviceId: drink, quantity: "1", isExternal: false },
    ];
    const booking = await s.tentative({ items });
    const confirmed = ok(
      await s.call(
        bookingSpecs.confirm,
        { ...s.confirmInput(booking, "17,000", SCHEDULE), expectedTotal: p("68,000") },
        s.reception.token,
      ),
    );
    // The catalog after confirmation (D-92: increases take today's prices).
    await db
      .update(packages)
      .set({ extraGuestPrice: p("180") })
      .where(eq(packages.id, s.gold));
    await db
      .update(services)
      .set({ unitPrice: p("25") })
      .where(eq(services.id, drink));
    return {
      ...s,
      kosha,
      drink,
      bookingId: booking.id,
      version: confirmed.version as number,
      depositId: confirmed.paymentId,
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const changes = (over: Record<string, unknown> = {}) => ({ guests: "200", ...over });

  /** Preview then save with the previewed total, as the dialog does. */
  async function amend(
    s: Scenario,
    over: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    token = s.reception.token,
  ) {
    const preview = ok(
      await s.call(bookingSpecs.previewItems, { bookingId: s.bookingId, changes: changes(over) }, token),
    );
    const version = (await db.select({ v: bookings.version }).from(bookings).where(eq(bookings.id, s.bookingId)))[0].v;
    const saved = await s.call(
      bookingSpecs.updateItems,
      { bookingId: s.bookingId, version, expectedTotal: preview.totalAfter, changes: changes(over), ...extra },
      token,
    );
    return { preview, saved };
  }
  const row = async (s: Scenario) => (await db.select().from(bookings).where(eq(bookings.id, s.bookingId)))[0];
  const schedule = async (s: Scenario) =>
    (
      await db.select().from(installments).where(eq(installments.bookingId, s.bookingId)).orderBy(installments.dueDate)
    ).map((l) => l.amount);
  const activeLines = (s: Scenario) =>
    db
      .select()
      .from(bookingItems)
      .where(and(eq(bookingItems.bookingId, s.bookingId), isNull(bookingItems.voidedAt)))
      .orderBy(bookingItems.sortOrder);

  it("GA-01: 200 → 230 guests adds 30 × 180 and 30 drinks × 25 as new lines: 74,150; the last installment takes the 6,150", async () => {
    const s = await scenario();
    const { preview, saved } = await amend(s, { guests: "230" });
    expect(preview).toMatchObject({ totalBefore: p("68,000"), totalAfter: p("74,150") });
    expect(ok(saved).total).toBe(p("74,150"));
    expect(await row(s)).toMatchObject({ guests: 230, total: p("74,150"), extraGuestsAmount: 0 });
    const added = (await activeLines(s)).filter((l) => l.source === "guest_adjustment");
    expect(added.map((l) => [l.name, l.quantity, l.unitPrice, l.lineTotal])).toEqual([
      ["معازيم زيادة", 30, p("180"), p("5,400")],
      ["مشروب", 30, p("25"), p("750")],
    ]);
    expect(await schedule(s)).toEqual([p("20,000"), p("37,150")]);
    const [change] = await db.select().from(bookingChanges).where(eq(bookingChanges.bookingId, s.bookingId));
    expect(change).toMatchObject({ kind: "guests", totalBefore: p("68,000"), totalAfter: p("74,150") });
    expect(added.every((l) => l.changeId === change.id)).toBe(true);
  });

  it("GA-02 / GA-03: back to 210 cancels 20 of the new guests at their prices (70,050); to 190 all of them and 10 drinks at the fixed 20 (67,800)", async () => {
    const s = await scenario();
    ok((await amend(s, { guests: "230" })).saved);
    expect(ok((await amend(s, { guests: "210" })).saved).total).toBe(p("70,050"));
    expect(ok((await amend(s, { guests: "190" })).saved).total).toBe(p("67,800"));
    const lines = await activeLines(s);
    expect(lines.filter((l) => l.source === "guest_adjustment")).toEqual([]);
    expect(lines.find((l) => l.serviceId === s.drink)).toMatchObject({ quantity: 190, unitPrice: p("20") });
    const voided = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, s.bookingId));
    expect(voided.filter((l) => l.voidedAt !== null).length).toBe(5); // 2 + 2 replaced, then the drink of 200
    expect((await row(s)).basePrice).toBe(p("60,000"));
  });

  it("GA-04: the reception types 160 per extra guest — the line keeps 180 and a pending 600 discount asks the difference (BR-41)", async () => {
    const s = await scenario();
    const typed = { guests: "230", extraGuestUnitPrice: "160" };
    const noReason = (await amend(s, typed)).saved;
    expect(failed(noReason).code).toBe("VALIDATION_ERROR");
    const { preview, saved } = await amend(s, typed, { overrideReason: "اتفاق مع المدير" });
    expect(preview).toMatchObject({ overrideDiscountTotal: p("600"), overrideApprovedAtOnce: false });
    expect(ok(saved)).toMatchObject({ total: p("74,150"), pendingDiscount: p("600") });
    const [request] = await db.select().from(discountRequests).where(eq(discountRequests.bookingId, s.bookingId));
    expect(request).toMatchObject({ amount: p("600"), status: "pending", source: "price_override" });
    const [change] = await db.select().from(bookingChanges);
    expect(change.kind).toBe("price_override");
  });

  it("GA-04 / BR-51: the manager typing 160 gets the 600 off at once: 73,550", async () => {
    const s = await scenario();
    const { saved } = await amend(
      s,
      { guests: "230", extraGuestUnitPrice: "160" },
      { overrideReason: "عميل قديم" },
      s.manager.token,
    );
    expect(ok(saved)).toMatchObject({ total: p("73,550"), pendingDiscount: 0 });
    expect(await row(s)).toMatchObject({ discountAmount: p("600"), total: p("73,550") });
  });

  it("GA-05: a typed 200 per extra guest applies: 74,750", async () => {
    const s = await scenario();
    expect(ok((await amend(s, { guests: "230", extraGuestUnitPrice: "200" })).saved).total).toBe(p("74,750"));
  });

  it("IT-01 / IT-08: taking the kosha off gives back its 4,000 (64,000); the deposit's receipt keeps 68,000 (D-122)", async () => {
    const s = await scenario();
    expect(ok((await amend(s, { remove: [s.kosha] })).saved).total).toBe(p("64,000"));
    expect(await schedule(s)).toEqual([p("20,000"), p("27,000")]);
    const receipt = ok(await s.call(paymentSpecs.receipt, { paymentId: s.depositId }));
    expect(receipt).toMatchObject({ total: p("68,000"), remaining: p("51,000") });
  });

  it("IT-02: removing the included DJ takes the 3,000 on the booking, not today's 3,500 (Q7-07); restoring gives it back", async () => {
    const s = await scenario();
    await db
      .update(packageItems)
      .set({ removalCredit: p("3,500") })
      .where(and(eq(packageItems.packageId, s.gold), eq(packageItems.serviceId, s.S.DJ)));
    expect(ok((await amend(s, { removeIncluded: [s.S.DJ] })).saved).total).toBe(p("65,000"));
    expect(ok((await amend(s, { restoreIncluded: [s.S.DJ] })).saved).total).toBe(p("68,000"));
    const zaffa = changes({ removeIncluded: [s.S.ZAFFA] });
    expect(failed(await s.call(bookingSpecs.previewItems, { bookingId: s.bookingId, changes: zaffa })).rule).toBe(
      "BR-33",
    );
  });

  it("IT-03: two extra photographers at 2,500, then three at today's 2,700, then back to two takes the newest line off", async () => {
    const s = await scenario();
    const add = [{ serviceId: s.S.PHOTO, quantity: "2", isExternal: false }];
    expect(ok((await amend(s, { add })).saved).total).toBe(p("73,000"));
    await db
      .update(services)
      .set({ unitPrice: p("2,700") })
      .where(eq(services.id, s.S.PHOTO));
    const three = [{ serviceId: s.S.PHOTO, quantity: "3" }];
    expect(ok((await amend(s, { quantities: three })).saved).total).toBe(p("75,700"));
    expect(ok((await amend(s, { quantities: [{ serviceId: s.S.PHOTO, quantity: "2" }] })).saved).total).toBe(
      p("73,000"),
    );
  });

  async function paidInFull(s: Scenario) {
    const remaining = p("51,000");
    ok(
      await s.call(paymentSpecs.record, { bookingId: s.bookingId, amount: String(remaining / 100), methodId: s.cash }),
    );
  }

  it("IT-04: paid in full, the kosha off under the refund policy refunds 4,000 with a receipt in the same operation", async () => {
    const s = await scenario("refund");
    await paidInFull(s);
    const { preview, saved } = await amend(
      s,
      { remove: [s.kosha] },
      { credit: { resolution: "refund", methodId: s.cash } },
      s.manager.token,
    );
    expect(preview).toMatchObject({ credit: p("4,000"), creditMode: "refund" });
    expect(ok(saved)).toMatchObject({ credit: p("4,000"), creditResolution: "refund", refund: { amount: p("4,000") } });
    const page = ok(await s.call(bookingSpecs.get, { bookingId: s.bookingId }));
    expect(page.money.ledger).toMatchObject({ total: p("64,000"), paid: p("64,000"), remaining: 0 });
    // The schedule follows the new total: 17,000 + 20,000 + 27,000.
    expect(await schedule(s)).toEqual([p("20,000"), p("27,000")]);
  });

  it("IT-05: under the services policy the credit stays (remaining −4,000) and a later 2,500 photographer takes 2,500 of it", async () => {
    const s = await scenario("services");
    await paidInFull(s);
    expect(ok((await amend(s, { remove: [s.kosha] })).saved)).toMatchObject({
      creditResolution: "services",
      refund: null,
    });
    let page = ok(await s.call(bookingSpecs.get, { bookingId: s.bookingId }));
    expect(page.money.ledger.remaining).toBe(-p("4,000"));
    ok((await amend(s, { add: [{ serviceId: s.S.PHOTO, quantity: "1", isExternal: false }] })).saved);
    page = ok(await s.call(bookingSpecs.get, { bookingId: s.bookingId }));
    expect(page.money.ledger.remaining).toBe(-p("1,500"));

    // BR-83: the credit is paid back once the party is over, not before.
    const after = new Date("2027-03-17T10:00:00Z");
    const ownerLater = await signIn(handle, OWNER.login, OWNER.password, after);
    const refund = (amount: string, now: Date, token: string) =>
      s.call(
        paymentSpecs.refund,
        { bookingId: s.bookingId, amount, methodId: s.cash, reason: "رصيد بعد الحفلة" },
        token,
        now,
      );
    expect(failed(await refund("1,500", NOW, s.manager.token)).rule).toBe("BR-83");
    expect(failed(await refund("1,500.01", after, ownerLater.token)).rule).toBe("BR-83");
    expect(ok(await refund("1,500", after, ownerLater.token)).receiptNo).toMatch(/^\d{6}$/);
    page = ok(await s.call(bookingSpecs.get, { bookingId: s.bookingId }));
    expect(page.money.ledger.remaining).toBe(0);
  });

  it("IT-06: a refund needs payments.refund — the reception's change is refused whole and nothing is written", async () => {
    const s = await scenario("refund");
    await paidInFull(s);
    const { saved } = await amend(s, { remove: [s.kosha] }, { credit: { resolution: "refund", methodId: s.cash } });
    expect(failed(saved).code).toBe("FORBIDDEN");
    expect(await row(s)).toMatchObject({ total: p("68,000") });
    expect(await db.select().from(bookingChanges)).toEqual([]);
    expect((await activeLines(s)).some((l) => l.serviceId === s.kosha)).toBe(true);
  });

  it("the both policy asks the staff member to choose (BR-83)", async () => {
    const s = await scenario("both");
    await paidInFull(s);
    expect(failed((await amend(s, { remove: [s.kosha] }, {}, s.manager.token)).saved).rule).toBe("BR-83");
    expect(
      ok((await amend(s, { remove: [s.kosha] }, { credit: { resolution: "services" } }, s.manager.token)).saved)
        .creditResolution,
    ).toBe("services");
  });

  it("IT-07 / PRICE_CHANGED: a second save on the same version is refused; a price change between preview and save is shown, not applied", async () => {
    const s = await scenario();
    const input = {
      bookingId: s.bookingId,
      version: s.version,
      expectedTotal: p("64,000"),
      changes: changes({ remove: [s.kosha] }),
    };
    ok(await s.call(bookingSpecs.updateItems, input));
    expect(failed(await s.call(bookingSpecs.updateItems, input)).code).toBe("CONCURRENT_MODIFICATION");

    const preview = ok(
      await s.call(bookingSpecs.previewItems, { bookingId: s.bookingId, changes: changes({ guests: "210" }) }),
    );
    await db
      .update(packages)
      .set({ extraGuestPrice: p("190") })
      .where(eq(packages.id, s.gold));
    const stale = await s.call(bookingSpecs.updateItems, {
      bookingId: s.bookingId,
      version: preview.version,
      expectedTotal: preview.totalAfter,
      changes: changes({ guests: "210" }),
    });
    expect(failed(stale)).toMatchObject({
      code: "PRICE_CHANGED",
      details: { total: p("64,000") + p("1,900") + p("250") },
    });
  });

  it("refuses: a tentative booking, more guests than the capacity, nothing to change; voided lines never change (D-128)", async () => {
    const s = await scenario();
    const tentative = await s.tentative({ eventDate: "2027-04-15" });
    expect(failed(await s.call(bookingSpecs.previewItems, { bookingId: tentative.id, changes: changes() })).rule).toBe(
      "BR-40",
    );
    expect(failed((await amend(s, { guests: "301" })).saved).rule).toBe("BR-05");
    expect(failed((await amend(s, {})).saved).code).toBe("VALIDATION_ERROR");
    expect(
      failed(
        await s.call(
          bookingSpecs.updateItems,
          { bookingId: s.bookingId, version: s.version, expectedTotal: 0, changes: changes() },
          s.accountant.token,
        ),
      ).code,
    ).toBe("FORBIDDEN");

    ok((await amend(s, { remove: [s.kosha] })).saved);
    const [voided] = await db.select().from(bookingItems).where(eq(bookingItems.serviceId, s.kosha));
    let code: string | undefined;
    try {
      await db.update(bookingItems).set({ quantity: 2 }).where(eq(bookingItems.id, voided.id));
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe("42501");
  });

  it("the booking page and its history show the active lines and the change (D-108)", async () => {
    const s = await scenario();
    ok((await amend(s, { guests: "230" })).saved);
    const page = ok(await s.call(bookingSpecs.get, { bookingId: s.bookingId }));
    expect(page.booking.total).toBe(p("74,150"));
    // Rows of one transaction share their time, so the edit is found, not taken first.
    const edit = page.history.find((h: { action: string }) => h.action === "bookings.update_items");
    expect(edit.changes.map((c: { field: string }) => c.field)).toEqual(
      expect.arrayContaining(["guests", "total", "added"]),
    );
  });
});
