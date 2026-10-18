import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/modules/shared/errors";
import { MAX_TRANSACTION_ATTEMPTS, retryDelayMs, runTransaction } from "@/modules/shared/transaction";

/**
 * D-113: a transaction aborted by a deadlock (40P01) or a serialization failure (40001) runs
 * again, up to three attempts with a short random wait; anything else is not retried; when
 * the attempts run out the error is RETRY_LATER ("the system is busy"), never a slot clash.
 */

const pgFailure = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

/** A database whose transaction runs `outcomes` in order: an Error is thrown, anything else returned. */
function fakeDb(outcomes: unknown[]) {
  let calls = 0;
  return {
    calls: () => calls,
    db: {
      transaction: async <T>(work: (tx: never) => Promise<T>) => {
        const outcome = outcomes[calls];
        calls += 1;
        if (outcome instanceof Error) throw outcome;
        return work(outcome as never);
      },
    },
  };
}

const noWait = async () => {};

describe("runTransaction (D-113)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["40P01", "40001"])("retries %s and returns the next attempt's result", async (code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, calls } = fakeDb([pgFailure(code), "tx"]);
    await expect(runTransaction(db as never, async () => "done", { sleep: noWait })).resolves.toBe("done");
    expect(calls()).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(`transaction retried after ${code} (attempt 2 of 3)`);
  });

  it("gives up after three attempts with RETRY_LATER, not CONFLICT_SLOT_TAKEN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, calls } = fakeDb([pgFailure("40P01"), pgFailure("40P01"), pgFailure("40001"), "tx"]);
    const error = await runTransaction(db as never, async () => "done", { sleep: noWait }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RETRY_LATER");
    expect(calls()).toBe(MAX_TRANSACTION_ATTEMPTS);
  });

  it("does not retry other database errors, app errors, or the slot constraint itself", async () => {
    for (const failure of [
      pgFailure("23P01"),
      pgFailure("23505"),
      new AppError("CONFLICT_SLOT_TAKEN", "slotTaken", { rule: "BR-11" }),
      new Error("network down"),
    ]) {
      const { db, calls } = fakeDb([failure, "tx"]);
      await expect(runTransaction(db as never, async () => "done", { sleep: noWait })).rejects.toBe(failure);
      expect(calls()).toBe(1);
    }
  });

  it("finds the SQLSTATE through wrapping errors (drizzle wraps the driver's)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapped = Object.assign(new Error("Failed query"), { cause: pgFailure("40P01") });
    const { db, calls } = fakeDb([wrapped, "tx"]);
    await expect(runTransaction(db as never, async () => "ok", { sleep: noWait })).resolves.toBe("ok");
    expect(calls()).toBe(2);
  });

  it("waits a short random time that grows with the attempt", async () => {
    expect(retryDelayMs(1, () => 0)).toBe(25);
    expect(retryDelayMs(1, () => 1)).toBe(100);
    expect(retryDelayMs(2, () => 0.5)).toBe(125);
    const waits: number[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeDb([pgFailure("40P01"), pgFailure("40P01"), "tx"]);
    await runTransaction(db as never, async () => "ok", { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(25);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(50);
    expect(waits[1]).toBeLessThanOrEqual(200);
  });
});
