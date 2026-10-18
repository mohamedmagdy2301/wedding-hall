import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { DbHandle } from "@/db/client";
import { bookings, payments } from "@/db/schema";
import { addDays } from "@/lib/time";
import { bookingSpecs } from "@/server/specs/bookings";
import { paymentSpecs } from "@/server/specs/payments";
import { type AnySpec, NOW, ok, type Result } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { callSpec } from "./helpers/fixtures";
import { p, paymentScenario, type PaymentScenario } from "./helpers/payment-scenario";

/**
 * PHASE6_PLAN §6.5: the phase 5 concurrency cases again, now through the full
 * `bookings.confirm` with its deposit (D-97) — C-01 (20 runs), C-05 and C-07 — and the
 * receipt counter (N-04) and BR-63 (L-06) under concurrency. Two pools: two real
 * connections, two independent transactions. C-02/C-03 need the commit held open, so they
 * stay on `markConfirmed` (bookings-concurrency.test.ts).
 */

// Twenty runs of real round trips: minutes on Neon, where files share one database in sequence.
const LONG = inject("testDatabasePerWorker") ? 180_000 : 900_000;

describe("concurrent confirmations and payments (BR-11, BR-61, BR-63, D-97)", () => {
  const first = connectTestDb();
  const second = connectTestDb();
  beforeEach(() => truncateAll(first));
  afterAll(async () => {
    await first.close();
    await second.close();
  });

  const on = (handle: DbHandle, s: PaymentScenario, spec: unknown, input: unknown) =>
    callSpec(handle, spec as AnySpec, s.reception.token, input, NOW) as Promise<Result>;

  it(
    "C-01: two tentative bookings on one slot confirmed at once with their deposits → exactly one wins, one deposit (20 runs)",
    async () => {
      const s = await paymentScenario(first);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let run = 0; run < 20; run += 1) {
        const date = addDays("2027-02-01", run * 2);
        const t1 = await s.tentative({ eventDate: date });
        const t2 = await s.tentative({ eventDate: date });
        const results = await Promise.all([
          on(first, s, bookingSpecs.confirm, s.confirmInput(t1, "15,000", [])),
          on(second, s, bookingSpecs.confirm, s.confirmInput(t2, "15,000", [])),
        ]);
        expect(
          results.filter((r) => r.ok),
          `run ${run}`,
        ).toHaveLength(1);
        const loser = results.find((r) => !r.ok) as Extract<Result, { ok: false }>;
        expect(loser.error.code).toBe("CONFLICT_SLOT_TAKEN");
        const rows = await first.db
          .select({ status: bookings.status })
          .from(bookings)
          .where(
            eq(bookings.startsAt, (await first.db.select().from(bookings).where(eq(bookings.id, t1.id)))[0].startsAt),
          );
        expect(rows.map((r) => r.status).sort()).toEqual(["confirmed", "tentative"]);
      }
      expect(await first.db.select().from(payments)).toHaveLength(20);
      const retried = warn.mock.calls.filter((c) => String(c[0]).startsWith("transaction retried")).length;
      warn.mockRestore();
      console.info(`C-01 (bookings.confirm): ${retried} deadlock retries in 20 runs`);
      expect(retried).toBe(0);
    },
    LONG,
  );

  it("C-05: the same slot in two spaces confirmed together → both succeed", async () => {
    const s = await paymentScenario(first);
    const a = await s.tentative();
    const roof = ok(
      await s.call(
        bookingSpecs.createTentative,
        s.minimal({
          spaceId: s.spaceB,
          eventDate: "2027-03-15",
          packageId: s.roof,
          guests: "50",
          eventTypeId: s.wedding,
          groomName: "أحمد",
          brideName: "منى",
        }),
      ),
    );
    const results = await Promise.all([
      on(first, s, bookingSpecs.confirm, s.confirmInput(a, "15,000", [])),
      on(second, s, bookingSpecs.confirm, {
        ...s.confirmInput(roof, "2,500", []),
        expectedTotal: p("10,000"),
      }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("C-07: the same booking confirmed twice at once on one version → one succeeds, the other is CONCURRENT_MODIFICATION, one deposit", async () => {
    const s = await paymentScenario(first);
    const t = await s.tentative();
    const results = await Promise.all([
      on(first, s, bookingSpecs.confirm, s.confirmInput(t, "15,000", [])),
      on(second, s, bookingSpecs.confirm, s.confirmInput(t, "20,000", [])),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((results.find((r) => !r.ok) as Extract<Result, { ok: false }>).error.code).toBe("CONCURRENT_MODIFICATION");
    expect(await first.db.select().from(payments).where(eq(payments.bookingId, t.id))).toHaveLength(1);
  });

  it(
    "N-04: 20 payments on 20 bookings at once get 20 consecutive receipt numbers, no duplicate and no gap (BR-61)",
    async () => {
      const s = await paymentScenario(first);
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1)
        ids.push((await s.confirmed("15,000", [], { eventDate: addDays("2027-02-01", i) })).id);
      const results = await Promise.all(
        ids.map((bookingId, i) =>
          on(i % 2 ? second : first, s, paymentSpecs.record, { bookingId, amount: "1,000", methodId: s.cash }),
        ),
      );
      const numbers = results.map((r) => ok(r).receiptNo as string).sort();
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => String(21 + i).padStart(6, "0")));
    },
    LONG,
  );

  it("L-06: two payments of 15,000 at once on a balance of 25,000 → one succeeds, the other is refused by BR-63", async () => {
    const s = await paymentScenario(first);
    const a = await s.confirmed("35,000", []);
    const pay = { bookingId: a.id, amount: "15,000", methodId: s.cash };
    const results = await Promise.all([
      on(first, s, paymentSpecs.record, pay),
      on(second, s, paymentSpecs.record, pay),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((results.find((r) => !r.ok) as Extract<Result, { ok: false }>).error.rule).toBe("BR-63");
  });
});
