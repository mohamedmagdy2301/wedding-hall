import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/db/client";
import { bookings } from "@/db/schema";
import { addDays } from "@/lib/time";
import { markConfirmed } from "@/modules/bookings/confirm-transition";
import { AppError } from "@/modules/shared/errors";
import { bookingWorld, insertRawBooking, TIERS, type World } from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";

/**
 * PHASE5_PLAN §9.4 (C-01..C-05), the phase 5 acceptance: two confirmations of clashing
 * bookings at the same moment, from two separate connections — exactly one wins. They run
 * through `markConfirmed`, the transition `bookings.confirm` will use in phase 6 (D-97).
 */

/** Resolves for everyone once `n` callers have arrived, so both transactions act together. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await all;
  };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("concurrent confirmations (BR-11, D-97)", () => {
  // Two pools: two real connections, two independent transactions.
  const first = connectTestDb();
  const second = connectTestDb();
  beforeEach(() => truncateAll(first));
  afterAll(async () => {
    await first.close();
    await second.close();
  });

  const evening = (date: string, space: "A" | "B" = "A") => ({
    space,
    status: "tentative" as const,
    start: [date, "20:00"] as [string, string],
    end: [addDays(date, 1), "01:00"] as [string, string],
  });

  function confirmIn(handle: DbHandle, w: World, bookingId: string, beforeUpdate: () => Promise<void>) {
    return handle.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await beforeUpdate();
      return markConfirmed(tx, {
        venueId: w.venueId,
        bookingId,
        confirmedBy: w.ownerId,
        now: new Date(),
        bufferMinutes: 60,
        cancellationBasis: "deposit",
        cancellationTiers: TIERS,
      });
    });
  }

  async function statuses(ids: string[]) {
    const rows = await first.db.select({ id: bookings.id, status: bookings.status }).from(bookings);
    return ids.map((id) => rows.find((r) => r.id === id)?.status);
  }

  it("C-01: two tentative bookings on one slot confirmed at the same moment → exactly one succeeds (20 runs)", async () => {
    const w = await bookingWorld(first);
    for (let run = 0; run < 20; run += 1) {
      const date = addDays("2027-02-01", run * 2);
      const t1 = await insertRawBooking(first, w, evening(date));
      const t2 = await insertRawBooking(first, w, evening(date));
      const wait = barrier(2);
      const results = await Promise.all([
        settle(confirmIn(first, w, t1, wait)),
        settle(confirmIn(second, w, t2, wait)),
      ]);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners, `run ${run}`).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const error = (losers[0] as { error: unknown }).error;
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFLICT_SLOT_TAKEN");
      expect((await statuses([t1, t2])).sort()).toEqual(["confirmed", "tentative"]);
    }
  });

  it("C-02: while the first confirmation is uncommitted the second waits, then fails when the first commits", async () => {
    const w = await bookingWorld(first);
    const t1 = await insertRawBooking(first, w, evening("2027-02-01"));
    const t2 = await insertRawBooking(first, w, evening("2027-02-01"));

    let commitFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (commitFirst = resolve));
    let firstUpdated!: () => void;
    const firstHasUpdated = new Promise<void>((resolve) => (firstUpdated = resolve));

    const one = settle(
      first.db.transaction(async (tx) => {
        await markConfirmed(tx, {
          venueId: w.venueId,
          bookingId: t1,
          confirmedBy: w.ownerId,
          now: new Date(),
          bufferMinutes: 60,
          cancellationBasis: "deposit",
          cancellationTiers: TIERS,
        });
        firstUpdated();
        await firstMayCommit;
      }),
    );
    await firstHasUpdated;
    const two = settle(confirmIn(second, w, t2, async () => {}));

    const early = await Promise.race([two.then(() => "finished"), sleep(300).then(() => "waiting")]);
    expect(early).toBe("waiting");

    commitFirst();
    expect((await one).ok).toBe(true);
    const result = await two;
    expect(result.ok).toBe(false);
    expect(((result as { error: unknown }).error as AppError).code).toBe("CONFLICT_SLOT_TAKEN");
    expect(await statuses([t1, t2])).toEqual(["confirmed", "tentative"]);
  });

  it("C-03: when the first confirmation rolls back, the waiting one succeeds — the constraint waits for the outcome", async () => {
    const w = await bookingWorld(first);
    const t1 = await insertRawBooking(first, w, evening("2027-02-01"));
    const t2 = await insertRawBooking(first, w, evening("2027-02-01"));

    let rollBackFirst!: () => void;
    const firstMayEnd = new Promise<void>((resolve) => (rollBackFirst = resolve));
    let firstUpdated!: () => void;
    const firstHasUpdated = new Promise<void>((resolve) => (firstUpdated = resolve));

    const one = settle(
      first.db.transaction(async (tx) => {
        await markConfirmed(tx, {
          venueId: w.venueId,
          bookingId: t1,
          confirmedBy: w.ownerId,
          now: new Date(),
          bufferMinutes: 60,
          cancellationBasis: "deposit",
          cancellationTiers: TIERS,
        });
        firstUpdated();
        await firstMayEnd;
        throw new Error("deposit failed"); // e.g. the phase 6 deposit insert fails
      }),
    );
    await firstHasUpdated;
    const two = settle(confirmIn(second, w, t2, async () => {}));
    expect(await Promise.race([two.then(() => "finished"), sleep(300).then(() => "waiting")])).toBe("waiting");

    rollBackFirst();
    expect((await one).ok).toBe(false);
    expect((await two).ok).toBe(true);
    expect(await statuses([t1, t2])).toEqual(["tentative", "confirmed"]);
  });

  it("C-04: adjacent bookings (the second starts at the first's blocked_until) confirmed together → both succeed", async () => {
    const w = await bookingWorld(first);
    const t1 = await insertRawBooking(first, w, evening("2027-02-01"));
    const t2 = await insertRawBooking(first, w, {
      space: "A",
      status: "tentative",
      start: ["2027-02-02", "02:00"],
      end: ["2027-02-02", "06:00"],
    });
    const wait = barrier(2);
    const results = await Promise.all([settle(confirmIn(first, w, t1, wait)), settle(confirmIn(second, w, t2, wait))]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("C-05: the same slot in two spaces confirmed together → both succeed (D-02)", async () => {
    const w = await bookingWorld(first);
    const t1 = await insertRawBooking(first, w, evening("2027-02-01", "A"));
    const t2 = await insertRawBooking(first, w, evening("2027-02-01", "B"));
    const wait = barrier(2);
    const results = await Promise.all([settle(confirmIn(first, w, t1, wait)), settle(confirmIn(second, w, t2, wait))]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("B-20 / D-110: the transition refuses a booking that is not tentative and locks the slot with the current buffer", async () => {
    const w = await bookingWorld(first);
    const t1 = await insertRawBooking(first, w, { ...evening("2027-02-01"), bufferMinutes: 60 });
    const result = await confirmIn(first, w, t1, async () => {})
      .then(() =>
        first.db.transaction((tx) =>
          markConfirmed(tx, {
            venueId: w.venueId,
            bookingId: t1,
            confirmedBy: w.ownerId,
            now: new Date(),
            bufferMinutes: 60,
            cancellationBasis: "deposit",
            cancellationTiers: TIERS,
          }),
        ),
      )
      .catch((e: unknown) => e);
    expect((result as AppError).rule).toBe("BR-21");

    // Saved with a 60-minute buffer, confirmed while the venue's buffer is 90.
    const t2 = await insertRawBooking(first, w, { ...evening("2027-03-01"), bufferMinutes: 60 });
    const confirmed = await first.db.transaction((tx) =>
      markConfirmed(tx, {
        venueId: w.venueId,
        bookingId: t2,
        confirmedBy: w.ownerId,
        now: new Date(),
        bufferMinutes: 90,
        cancellationBasis: "deposit",
        cancellationTiers: TIERS,
      }),
    );
    expect(confirmed.version).toBe(2);
    const [row] = await first.db
      .select({ endsAt: bookings.endsAt, blockedUntil: bookings.blockedUntil, tiers: bookings.cancellationTiers })
      .from(bookings)
      .where(eq(bookings.id, t2));
    expect(row.blockedUntil.getTime() - row.endsAt.getTime()).toBe(90 * 60_000);
    expect(row.tiers).toEqual([{ min_days_before: 0, refund_bps: 0 }]);
  });
});
