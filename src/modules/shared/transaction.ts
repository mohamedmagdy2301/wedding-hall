import type { Db } from "@/db/client";
import type { Tx } from "./db";
import { AppError, pgError } from "./errors";

/**
 * Runs a transaction and retries it when PostgreSQL aborted it only because of the timing
 * of another transaction (D-113): a deadlock (40P01) or a serialization failure (40001).
 * Such an abort says nothing about the data, so the whole transaction runs again and the
 * database gives the real verdict — success, or the error a constraint raises (e.g.
 * `bookings_no_overlap` → CONFLICT_SLOT_TAKEN). When the attempts run out the user is told
 * the system is busy, never that the slot is taken.
 *
 * Retrying is safe because everything the work does is inside the transaction: an aborted
 * attempt leaves no row, no audit line and no booking number behind (BR-26, D-105). The
 * work must therefore not call anything outside the database.
 */

export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);
export const MAX_TRANSACTION_ATTEMPTS = 3;

/** A short random wait before the next attempt, growing with each attempt (25–100 ms × attempt). */
export const retryDelayMs = (attempt: number, random = Math.random) => Math.round((25 + random() * 75) * attempt);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isRetryable = (error: unknown) =>
  !(error instanceof AppError) && RETRYABLE_SQLSTATES.has(pgError(error).code ?? "");

export async function runTransaction<T>(
  db: Pick<Db, "transaction">,
  work: (tx: Tx) => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? MAX_TRANSACTION_ATTEMPTS;
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      const code = pgError(error).code;
      if (attempt >= attempts) {
        console.warn(`transaction gave up after ${attempts} attempts (${code})`);
        throw new AppError("RETRY_LATER", "systemBusy");
      }
      console.warn(`transaction retried after ${code} (attempt ${attempt + 1} of ${attempts})`);
      await sleep(retryDelayMs(attempt));
    }
  }
}
