import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookingItems, bookings, customers } from "@/db/schema";
import { cairoInstant } from "@/lib/time";
import { findOverlapping } from "@/modules/bookings/repository";
import { AppError } from "@/modules/shared/errors";
import {
  bookingWorld,
  confirmBooking,
  insertRawBooking,
  rawTimes,
  type RawBooking,
  type World,
} from "./helpers/bookings";
import { connectTestDb, truncateAll } from "./helpers/db";
import { PG_CHECK_VIOLATION, PG_EXCLUSION_VIOLATION, pgErrorCode } from "./helpers/pg-error";

/**
 * PHASE5_PLAN §9.3: `bookings_no_overlap` with real times (O-01..O-21). Every case runs
 * twice: (a) on the constraint itself, inserting rows directly — the guarantee lives in the
 * database (CLAUDE.md rule 3); (b) on the code's overlap query, which must give the same
 * verdict (the warnings of BR-12 and the conflicting status of BR-13).
 *
 * E = the confirmed evening of space A on 2027-01-15, 20:00 → 01:00 (+1), blocked until
 * 02:00 (+1) with the 60-minute buffer (Cairo +02:00).
 */

const E: RawBooking = { status: "confirmed", start: ["2027-01-15", "20:00"], end: ["2027-01-16", "01:00"] };

type Case = {
  id: string;
  name: string;
  existing?: RawBooking[];
  candidate: RawBooking;
  rejected: boolean;
};

const confirmed = (start: [string, string], end: [string, string], extra: Partial<RawBooking> = {}): RawBooking => ({
  status: "confirmed",
  start,
  end,
  ...extra,
});

const CASES: Case[] = [
  { id: "O-01", name: "the same slot", candidate: confirmed(E.start, E.end), rejected: true },
  {
    id: "O-02",
    name: "full overlap containing E (full day)",
    candidate: confirmed(["2027-01-15", "13:00"], ["2027-01-16", "01:00"]),
    rejected: true,
  },
  {
    id: "O-03",
    name: "full overlap inside E",
    candidate: confirmed(["2027-01-15", "21:00"], ["2027-01-15", "23:00"]),
    rejected: true,
  },
  {
    id: "O-04",
    name: "partial overlap at E's start",
    candidate: confirmed(["2027-01-15", "17:00"], ["2027-01-15", "20:30"]),
    rejected: true,
  },
  {
    id: "O-05",
    name: "partial overlap at E's end",
    candidate: confirmed(["2027-01-15", "23:00"], ["2027-01-16", "03:00"]),
    rejected: true,
  },
  {
    id: "O-06",
    name: "adjacent: starts exactly at E's blocked_until ('[)')",
    candidate: confirmed(["2027-01-16", "02:00"], ["2027-01-16", "06:00"]),
    rejected: false,
  },
  {
    id: "O-07",
    name: "inside E's buffer (BR-10)",
    candidate: confirmed(["2027-01-16", "01:30"], ["2027-01-16", "06:00"]),
    rejected: true,
  },
  {
    id: "O-08",
    name: "before E, its buffer ends exactly at E's start",
    candidate: confirmed(["2027-01-15", "13:00"], ["2027-01-15", "19:00"]),
    rejected: false,
  },
  {
    id: "O-09",
    name: "before E, its own buffer runs into E",
    candidate: confirmed(["2027-01-15", "13:00"], ["2027-01-15", "19:30"]),
    rejected: true,
  },
  {
    id: "O-10",
    name: "the default day slot on E's date (BR-02)",
    candidate: confirmed(["2027-01-15", "13:00"], ["2027-01-15", "18:00"]),
    rejected: false,
  },
  {
    id: "O-11",
    name: "another space, same times (D-02)",
    candidate: confirmed(E.start, E.end, { space: "B" }),
    rejected: false,
  },
  { id: "O-13", name: "a cancelled booking on E's slot", candidate: { ...E, status: "cancelled" }, rejected: false },
  {
    id: "O-14",
    name: "E is cancelled, then a confirmed booking takes its slot (BR-74)",
    existing: [{ ...E, status: "cancelled" }],
    candidate: confirmed(E.start, E.end),
    rejected: false,
  },
  {
    id: "O-16",
    name: "the next day's day slot after an evening past midnight (D-69)",
    candidate: confirmed(["2027-01-16", "13:00"], ["2027-01-16", "18:00"]),
    rejected: false,
  },
  {
    id: "O-17a",
    name: "summer time ends: 01:30 (+02) on 2027-10-29 is inside E2's buffer",
    existing: [confirmed(["2027-10-28", "20:00"], ["2027-10-29", "01:00"])],
    candidate: confirmed(["2027-10-29", "01:30"], ["2027-10-29", "05:00"]),
    rejected: true,
  },
  {
    id: "O-17b",
    name: "summer time ends: 02:00 (+02) on 2027-10-29 is E2's blocked_until",
    existing: [confirmed(["2027-10-28", "20:00"], ["2027-10-29", "01:00"])],
    candidate: confirmed(["2027-10-29", "02:00"], ["2027-10-29", "05:00"]),
    rejected: false,
  },
  {
    id: "O-18a",
    name: "summer time starts: 01:30 (+03) on 2027-04-30 is inside E3's buffer",
    existing: [confirmed(["2027-04-29", "20:00"], ["2027-04-30", "01:00"])],
    candidate: confirmed(["2027-04-30", "01:30"], ["2027-04-30", "05:00"]),
    rejected: true,
  },
  {
    id: "O-18b",
    name: "summer time starts: 02:00 (+03) on 2027-04-30 is E3's blocked_until",
    existing: [confirmed(["2027-04-29", "20:00"], ["2027-04-30", "01:00"])],
    candidate: confirmed(["2027-04-30", "02:00"], ["2027-04-30", "05:00"]),
    rejected: false,
  },
  {
    id: "O-19",
    name: "the buffer drops to 30 after E was saved: E keeps its stored blocked_until (BR-10)",
    candidate: confirmed(["2027-01-16", "01:30"], ["2027-01-16", "06:00"], { bufferMinutes: 30 }),
    rejected: true,
  },
  {
    id: "O-20",
    name: "a past confirmed booking (completed) is still in the constraint",
    existing: [confirmed(["2025-01-15", "20:00"], ["2025-01-16", "01:00"])],
    candidate: confirmed(["2025-01-15", "21:00"], ["2025-01-15", "23:00"]),
    rejected: true,
  },
  {
    id: "O-21",
    name: "one minute into E's buffer",
    candidate: confirmed(["2027-01-16", "01:59"], ["2027-01-16", "06:00"]),
    rejected: true,
  },
];

describe("bookings_no_overlap with real times (BR-10, BR-11, BR-12)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  it.each(CASES)("$id: $name → rejected: $rejected", async ({ existing, candidate, rejected }) => {
    const w = await bookingWorld(handle);
    for (const b of existing ?? [E]) await insertRawBooking(handle, w, b);

    // (b) the code's query sees the same clash the constraint will (a cancelled candidate
    // still overlaps E in time; it is only outside the constraint).
    if (candidate.status === "confirmed") {
      const found = await findOverlapping(
        db,
        { venueId: w.venueId, spaceId: candidate.space === "B" ? w.spaceB : w.spaceA, ...rawTimes(candidate) },
        new Date(),
      );
      expect(found.confirmed.length > 0).toBe(rejected);
    }

    // (a) the constraint itself.
    const outcome = await insertRawBooking(handle, w, candidate).then(
      () => "saved",
      (e: unknown) => pgErrorCode(e),
    );
    expect(outcome).toBe(rejected ? PG_EXCLUSION_VIOLATION : "saved");
  });

  it("O-12: tentative bookings on E's slot are outside the constraint, several at once (BR-12, D-08)", async () => {
    const w = await bookingWorld(handle);
    await insertRawBooking(handle, w, E);
    await insertRawBooking(handle, w, { ...E, status: "tentative" });
    await insertRawBooking(handle, w, { ...E, status: "tentative" });
    const found = await findOverlapping(db, { venueId: w.venueId, spaceId: w.spaceA, ...rawTimes(E) }, new Date());
    expect(found.confirmed).toHaveLength(1);
    expect(found.tentative).toHaveLength(2);
  });

  it("O-15: confirming a tentative booking onto E's slot is refused — on UPDATE too — and it stays tentative", async () => {
    const w = await bookingWorld(handle);
    await insertRawBooking(handle, w, E);
    const tentative = await insertRawBooking(handle, w, { ...E, status: "tentative" });

    const raw = await db
      .update(bookings)
      .set({
        status: "confirmed",
        confirmedAt: new Date(),
        confirmedBy: w.ownerId,
        cancellationBasis: "deposit",
        cancellationTiers: [],
      })
      .where(eq(bookings.id, tentative))
      .catch((e: unknown) => e);
    expect(pgErrorCode(raw)).toBe(PG_EXCLUSION_VIOLATION);

    const error = await confirmBooking(handle, w, tentative).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("CONFLICT_SLOT_TAKEN");
    expect((error as AppError).rule).toBe("BR-11");
    const [row] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, tentative));
    expect(row.status).toBe("tentative");
  });

  it("expired tentative bookings are not reported; another venue's bookings never are", async () => {
    const w = await bookingWorld(handle);
    await insertRawBooking(handle, w, { ...E, status: "tentative", tentativeExpiresAt: new Date(Date.now() - 1000) });
    const found = await findOverlapping(db, { venueId: w.venueId, spaceId: w.spaceA, ...rawTimes(E) }, new Date());
    expect(found.tentative).toHaveLength(0);
    const other = await findOverlapping(
      db,
      { venueId: "00000000-0000-4000-8000-000000000000", spaceId: w.spaceA, ...rawTimes(E) },
      new Date(),
    );
    expect(other.confirmed).toHaveLength(0);
  });
});

describe("bookings: other database guarantees (D-98, D-103, D-107)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  async function tentativeRow(w: World) {
    return insertRawBooking(handle, w, { ...E, status: "tentative" });
  }

  it("B-13: a confirmed booking missing its package, event type or policy snapshot is refused by the database (D-98)", async () => {
    const w = await bookingWorld(handle);
    const id = await tentativeRow(w);
    for (const missing of [{ eventTypeId: null }, { cancellationTiers: null }, { confirmedBy: null }]) {
      const error = await db
        .update(bookings)
        .set({
          status: "confirmed",
          confirmedAt: new Date(),
          confirmedBy: w.ownerId,
          cancellationBasis: "deposit",
          cancellationTiers: [],
          ...missing,
        })
        .where(eq(bookings.id, id))
        .catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);
    }
  });

  it("B-13: times — end before start, more than 24 hours, blocked_until before the end", async () => {
    const w = await bookingWorld(handle);
    const id = await tentativeRow(w);
    const start = cairoInstant("2027-01-15", "20:00");
    for (const patch of [
      { endsAt: start, blockedUntil: start },
      { endsAt: new Date(start.getTime() + 25 * 3_600_000), blockedUntil: new Date(start.getTime() + 25 * 3_600_000) },
      { blockedUntil: new Date(start.getTime() + 3_600_000) },
    ]) {
      const error = await db
        .update(bookings)
        .set(patch)
        .where(eq(bookings.id, id))
        .catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);
    }
  });

  it("B-13: the price group is all empty without a package and complete with one (D-103)", async () => {
    const w = await bookingWorld(handle);
    const id = await tentativeRow(w);
    for (const patch of [{ total: null }, { packageId: null }, { guests: null }, { basePrice: -1 }]) {
      const error = await db
        .update(bookings)
        .set(patch)
        .where(eq(bookings.id, id))
        .catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);
    }
    await expect(
      db
        .update(bookings)
        .set({
          packageId: null,
          guests: null,
          basePrice: null,
          extraGuestsAmount: null,
          itemsTotal: null,
          removalCreditsTotal: null,
          discountAmount: null,
          total: null,
          baseGuests: null,
          extraGuestPrice: null,
        })
        .where(eq(bookings.id, id)),
    ).resolves.toBeDefined();
  });

  it("B-12: bookings and customers are never deleted; lines only while the booking is tentative (D-107)", async () => {
    const w = await bookingWorld(handle);
    const tentative = await tentativeRow(w);
    const line = (bookingId: string) => ({
      venueId: w.venueId,
      bookingId,
      name: "دي جي",
      category: "service" as const,
      pricingType: "fixed" as const,
      unitPrice: 0,
      quantity: 1,
      source: "package" as const,
      lineTotal: 0,
      sortOrder: 0,
    });
    await db.insert(bookingItems).values(line(tentative));
    await expect(db.delete(bookingItems).where(eq(bookingItems.bookingId, tentative))).resolves.toBeDefined();

    const confirmedId = await insertRawBooking(handle, w, confirmed(["2027-02-01", "20:00"], ["2027-02-02", "01:00"]));
    await db.insert(bookingItems).values(line(confirmedId));
    const deleteLines = await db
      .delete(bookingItems)
      .where(eq(bookingItems.bookingId, confirmedId))
      .catch((e: unknown) => e);
    expect(pgErrorCode(deleteLines)).toBe("42501");

    expect(
      pgErrorCode(
        await db
          .delete(bookings)
          .where(eq(bookings.id, tentative))
          .catch((e: unknown) => e),
      ),
    ).toBe("42501");
    expect(
      pgErrorCode(
        await db
          .delete(customers)
          .where(eq(customers.id, w.customerId))
          .catch((e: unknown) => e),
      ),
    ).toBe("42501");
  });

  it("B-19: the code's Cairo times equal PostgreSQL's AT TIME ZONE 'Africa/Cairo' (D-100)", async () => {
    const samples: [string, string][] = [
      ["2027-01-15", "13:00"],
      ["2027-01-15", "20:00"],
      ["2027-01-16", "01:00"],
      ["2027-07-10", "20:00"],
      ["2027-10-28", "20:00"],
      ["2027-10-28", "23:30"],
      ["2027-10-29", "01:00"],
      ["2027-04-29", "20:00"],
      ["2027-04-30", "00:30"],
      ["2027-04-30", "01:00"],
      ["2026-10-29", "23:30"],
    ];
    for (const [date, time] of samples) {
      const result = await db.execute(sql`SELECT ((${date}::date + ${time}::time) AT TIME ZONE 'Africa/Cairo') AS at`);
      const at = new Date((result.rows[0] as { at: string | Date }).at);
      expect(at.toISOString(), `${date} ${time}`).toBe(cairoInstant(date, time).toISOString());
    }
  });
});
