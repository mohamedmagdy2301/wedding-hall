import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs,
  bookingItems,
  bookings,
  installments,
  packages,
  payments,
  receiptCounters,
  services,
} from "@/db/schema";
import { bookingSpecs } from "@/server/specs/bookings";
import { paymentSpecs } from "@/server/specs/payments";
import { connectTestDb, truncateAll } from "./helpers/db";
import { failed, NOW, ok } from "./helpers/booking-scenario";
import { I01, p, paymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE6_PLAN §6.5, CF-01..CF-09 and MD-08: confirming through the real action pipeline
 * (session → Zod → permission → service) — the re-pricing (D-41, D-124), the deposit
 * (BR-21, D-119), the policy snapshot (D-68), the schedule (BR-65) and BR-22's single
 * transaction.
 */

describe("confirming with a deposit (BR-21, BR-22, BR-23)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const bookingRow = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
  const paymentRows = (bookingId: string) => db.select().from(payments).where(eq(payments.bookingId, bookingId));
  const scheduleRows = (bookingId: string) =>
    db.select().from(installments).where(eq(installments.bookingId, bookingId)).orderBy(installments.dueDate);

  it("CF-01: a complete tentative booking + a deposit ≥ the minimum → confirmed, deposit 000001, price, policy and buffer fixed, audited (BR-21, BR-22, D-68, D-110)", async () => {
    const s = await paymentScenario(handle);
    const booking = await s.tentative();
    const result = ok(await s.call(bookingSpecs.confirm, s.confirmInput(booking), s.reception.token));
    expect(result).toMatchObject({ receiptNo: "000001", total: p("60,000"), bookingNo: booking.bookingNo });

    const row = await bookingRow(booking.id);
    expect(row.status).toBe("confirmed");
    expect(row.total).toBe(p("60,000"));
    expect(row.confirmedBy).toBe(s.reception.actor.userId);
    expect(row.cancellationBasis).toBe("deposit");
    expect(row.cancellationTiers).toEqual([
      { min_days_before: 0, refund_bps: 0 },
      { min_days_before: 30, refund_bps: 5000 },
    ]);
    expect(row.blockedUntil.getTime() - row.endsAt.getTime()).toBe(60 * 60_000);

    const [deposit] = await paymentRows(booking.id);
    expect(deposit).toMatchObject({
      kind: "deposit",
      amount: p("15,000"),
      receiptNo: "000001",
      paymentMethodId: s.cash,
    });
    expect(deposit.paidAt.getTime()).toBe(NOW.getTime());
    expect((await scheduleRows(booking.id)).map((l) => [l.dueDate, l.amount])).toEqual([
      ["2027-01-15", p("20,000")],
      ["2027-03-14", p("25,000")],
    ]);

    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["bookings.confirm", "payments.record"]));

    const page = ok(await s.call(bookingSpecs.get, { bookingId: booking.id }));
    expect(page.money.ledger).toEqual({ total: p("60,000"), paid: p("15,000"), remaining: p("45,000") });
    expect(page.money.installments.map((l: { state: string }) => l.state)).toEqual(["upcoming", "upcoming"]);
    expect(page.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(["bookings.confirm", "payments.record", "bookings.create_tentative"]),
    );
  });

  it("CF-02: a wedding without the groom's name is refused and nothing is written — no payment, no receipt number", async () => {
    const s = await paymentScenario(handle);
    const booking = await s.tentative({ groomName: "" });
    const error = failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking)));
    expect(error).toMatchObject({ code: "BUSINESS_RULE_VIOLATION", rule: "BR-21" });
    expect(Object.keys(error.fieldErrors ?? {})).toEqual(["groomName"]);
    expect((await bookingRow(booking.id)).status).toBe("tentative");
    expect(await paymentRows(booking.id)).toEqual([]);
    expect(await db.select().from(receiptCounters)).toEqual([]);
  });

  it("CF-03: a venue without cancellation tiers cannot confirm (BR-21 item 5)", async () => {
    const s = await paymentScenario(handle, { policies: false });
    const booking = await s.tentative();
    expect(failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking)))).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "BR-21",
      message: expect.stringContaining("الإعداد"),
    });
  });

  it("CF-04: an expired booking confirms when the slot is free, and gets CONFLICT_SLOT_TAKEN with no payment when it is not (BR-21 item 4)", async () => {
    const s = await paymentScenario(handle);
    const later = new Date(NOW.getTime() + 72 * 3_600_000); // past the 48-hour hold
    const free = await s.tentative();
    const confirmed = ok(await s.call(bookingSpecs.confirm, s.confirmInput(free), s.reception.token, later));
    expect(confirmed.receiptNo).toBe("000001");

    const clashing = await s.tentative();
    expect(
      failed(await s.call(bookingSpecs.confirm, s.confirmInput(clashing), s.reception.token, later)),
    ).toMatchObject({
      code: "CONFLICT_SLOT_TAKEN",
    });
    expect(await paymentRows(clashing.id)).toEqual([]);
    expect((await bookingRow(clashing.id)).status).toBe("tentative");
  });

  it("CF-05 / MD-08: the price changed since the last quote → PRICE_CHANGED with the new total and nothing written; then 25% of 64,000 refuses 15,000 and accepts 16,000", async () => {
    const s = await paymentScenario(handle);
    const booking = await s.tentative();
    await s.setEveningPrice("64,000");

    const changed = failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking)));
    expect(changed).toMatchObject({ code: "PRICE_CHANGED", rule: "D-41" });
    const details = (changed as { details?: Record<string, unknown> }).details!;
    expect(details).toMatchObject({ total: p("64,000"), previousTotal: p("60,000"), expectedTotal: p("60,000") });
    expect((await bookingRow(booking.id)).total).toBe(p("60,000"));
    expect(await paymentRows(booking.id)).toEqual([]);

    const seen = { expectedTotal: p("64,000") };
    const low = failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking, "15,000", [], seen)));
    expect(low).toMatchObject({ code: "BUSINESS_RULE_VIOLATION", rule: "BR-21" });
    expect((low as { details?: Record<string, unknown> }).details).toEqual({ minimum: p("16,000") });

    ok(await s.call(bookingSpecs.confirm, s.confirmInput(booking, "16,000", [], seen)));
    const row = await bookingRow(booking.id);
    expect(row.basePrice).toBe(p("64,000"));
    expect(row.total).toBe(p("64,000"));
  });

  it("CF-06: an inactive package, or an added service made inactive, blocks confirming (D-95)", async () => {
    const s = await paymentScenario(handle);
    const withBand = await s.tentative({ items: [{ serviceId: s.S.BAND, quantity: "1", isExternal: false }] });
    await db.update(services).set({ isActive: false }).where(eq(services.id, s.S.BAND));
    const total = p("64,000"); // 60,000 + one band at 4,000
    expect(
      failed(await s.call(bookingSpecs.confirm, s.confirmInput(withBand, "16,000", [], { expectedTotal: total }))),
    ).toMatchObject({ code: "BUSINESS_RULE_VIOLATION", rule: "D-87" });

    const plain = await s.tentative();
    await db.update(packages).set({ isActive: false }).where(eq(packages.id, s.gold));
    expect(failed(await s.call(bookingSpecs.confirm, s.confirmInput(plain)))).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "D-87",
    });
    expect(await db.select().from(payments)).toEqual([]);
  });

  it("CF-07: a wrong schedule refuses the whole confirmation (BR-65, D-33)", async () => {
    const s = await paymentScenario(handle);
    const booking = await s.tentative();
    const onTheDay = [I01[0], { dueDate: "2027-03-15", amount: "25,000" }];
    expect(failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking, "15,000", onTheDay)))).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "BR-65",
      fieldErrors: { "installments.1.dueDate": expect.any(String) },
    });
    const short = [I01[0], { dueDate: "2027-03-14", amount: "24,999.99" }];
    const error = failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking, "15,000", short)));
    expect((error as { details?: Record<string, unknown> }).details).toEqual({ difference: 1 });
    expect((await bookingRow(booking.id)).status).toBe("tentative");
    expect(await scheduleRows(booking.id)).toEqual([]);
  });

  it("CF-08: a refusal at the last step (the constraint) leaves no deposit, no schedule, no lines changed and no receipt number used (TESTING: Transactions)", async () => {
    const s = await paymentScenario(handle);
    const first = await s.confirmed();
    const second = await s.tentative({ items: [{ serviceId: s.S.PHOTO, quantity: "2", isExternal: false }] });
    const linesBefore = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, second.id));
    const input = s.confirmInput(second, "16,250", [], { expectedTotal: p("65,000") });
    expect(failed(await s.call(bookingSpecs.confirm, input))).toMatchObject({ code: "CONFLICT_SLOT_TAKEN" });
    expect(await paymentRows(second.id)).toEqual([]);
    expect(await scheduleRows(second.id)).toEqual([]);
    const linesAfter = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, second.id));
    expect(linesAfter.map((l) => l.id).sort()).toEqual(linesBefore.map((l) => l.id).sort());
    const [counter] = await db.select().from(receiptCounters);
    expect(counter.lastNo).toBe(1);
    expect(first.receiptNo).toBe("000001");
  });

  it("CF-09: createConfirmed makes a confirmed booking at once with its number and receipt; it needs create, confirm and payments.record (BR-23, D-123)", async () => {
    const s = await paymentScenario(handle);
    const input = {
      ...s.weddingInput(),
      expectedTotal: p("60,000"),
      deposit: { amount: "15,000", methodId: s.cash },
      installments: I01,
    };
    const created = ok(await s.call(bookingSpecs.createConfirmed, input, s.reception.token));
    expect(created).toMatchObject({ bookingNo: "2026-0001", receiptNo: "000001" });
    expect((await bookingRow(created.id)).status).toBe("confirmed");
    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["bookings.create_confirmed", "payments.record"]));

    // The accountant confirms but does not create; a creator without bookings.confirm cannot either.
    expect(failed(await s.call(bookingSpecs.createConfirmed, input, s.accountant.token)).code).toBe("FORBIDDEN");
    const creator = await s.staffWith("creator", ["bookings.view", "bookings.create", "payments.record"]);
    expect(failed(await s.call(bookingSpecs.createConfirmed, input, creator.token)).code).toBe("FORBIDDEN");
    const noPayments = await s.staffWith("confirmer", ["bookings.view", "bookings.confirm"]);
    const booking = await s.tentative({ eventDate: "2027-04-15" });
    expect(
      failed(await s.call(bookingSpecs.confirm, s.confirmInput(booking, "15,000", []), noPayments.token)).code,
    ).toBe("FORBIDDEN");
    // A failed createConfirmed gives its booking number back (BR-26).
    expect(
      failed(await s.call(bookingSpecs.createConfirmed, { ...input, deposit: { amount: "100", methodId: s.cash } })),
    ).toMatchObject({ rule: "BR-21" });
    const next = ok(await s.call(bookingSpecs.createTentative, s.weddingInput({ eventDate: "2027-05-15" })));
    expect(next.bookingNo).toBe("2026-0003");
  });

  it("the accountant confirms a tentative booking (default roles, D-123), and the deposit's receipt is printable by bookings.view", async () => {
    const s = await paymentScenario(handle);
    const booking = await s.tentative();
    const result = ok(await s.call(bookingSpecs.confirm, s.confirmInput(booking), s.accountant.token));
    const receipt = ok(await s.call(paymentSpecs.receipt, { paymentId: result.paymentId }, s.reception.token));
    expect(receipt).toMatchObject({
      receiptNo: "000001",
      kind: "deposit",
      amount: p("15,000"),
      paid: p("15,000"),
      remaining: p("45,000"),
      bookingNo: booking.bookingNo,
      methodName: "كاش",
      venueName: "قاعة الاختبار",
    });
  });
});
