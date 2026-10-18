import { and, eq, sql } from "drizzle-orm";
import { bookings } from "@/db/schema";
import type { CancellationTier } from "@/domain/cancellation-tiers";
import type { Tx } from "@/modules/shared/db";
import { AppError, pgError, ruleViolation } from "@/modules/shared/errors";

/**
 * The only place a booking becomes `confirmed` (D-97). The `bookings_no_overlap` constraint
 * decides (BR-11, BR-21 item 3): a clash is `CONFLICT_SLOT_TAKEN` and, since it runs inside
 * the caller's transaction, nothing of the confirmation is kept (BR-22). It first queues on
 * the space (D-115) so clashing confirmations do not deadlock; callers still run it inside
 * `runTransaction`, which retries any deadlock left (D-113).
 *
 * Phase 5 calls it from tests only: no Server Action or screen may import this file — an
 * ESLint rule and a unit test guard that (D-97). Phase 6's `bookings.confirm` wraps it with
 * the deposit, the re-pricing (D-41, D-95) and the readiness and completeness checks.
 */

export type ConfirmTransitionInput = {
  venueId: string;
  bookingId: string;
  confirmedBy: string;
  now: Date;
  /** The venue's buffer now: the confirmation locks the slot with it (D-110). */
  bufferMinutes: number;
  /** The cancellation policy snapshot (D-68). */
  cancellationBasis: "deposit" | "total_paid";
  cancellationTiers: readonly CancellationTier[];
};

/**
 * Queues the transaction behind any other one changing confirmed bookings of the same space
 * (D-115): a transaction-scoped advisory lock keyed by the space, released at commit or
 * rollback. Confirmations of one space then wait their turn — the second sees the first
 * committed and the constraint refuses it at once — instead of each waiting for the other
 * inside the constraint check (a deadlock). Take it first in the transaction; taking it
 * again is harmless. Two spaces sharing a hash only share the queue.
 */
export async function queueOnSpace(tx: Tx, spaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bookings_no_overlap:${spaceId}`}, 0))`);
}

export async function markConfirmed(tx: Tx, input: ConfirmTransitionInput): Promise<{ version: number }> {
  const [booking] = await tx
    .select({ spaceId: bookings.spaceId })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.venueId, input.venueId)));
  if (!booking) throw ruleViolation("BR-21", "bookingNotTentative");
  await queueOnSpace(tx, booking.spaceId);
  const tiers = input.cancellationTiers.map((t) => ({ min_days_before: t.minDaysBefore, refund_bps: t.refundBps }));
  try {
    const [row] = await tx
      .update(bookings)
      .set({
        status: "confirmed",
        confirmedAt: input.now,
        confirmedBy: input.confirmedBy,
        cancellationBasis: input.cancellationBasis,
        cancellationTiers: tiers,
        blockedUntil: sql`${bookings.endsAt} + make_interval(mins => ${input.bufferMinutes})`,
        version: sql`${bookings.version} + 1`,
      })
      .where(
        and(eq(bookings.id, input.bookingId), eq(bookings.venueId, input.venueId), eq(bookings.status, "tentative")),
      )
      .returning({ version: bookings.version });
    if (!row) throw ruleViolation("BR-21", "bookingNotTentative");
    return row;
  } catch (error) {
    // The slot is taken by a committed confirmation. A deadlock (two clashing confirmations
    // waiting for each other inside the constraint check, seen in C-01) is not mapped here:
    // the caller's runTransaction retries it and the constraint then gives the real verdict
    // (D-113).
    if (pgError(error).code === "23P01") {
      throw new AppError("CONFLICT_SLOT_TAKEN", "slotTaken", { rule: "BR-11" });
    }
    throw error;
  }
}
