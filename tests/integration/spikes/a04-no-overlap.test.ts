import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb } from "../helpers/db";
import { PG_EXCLUSION_VIOLATION, pgErrorCode } from "../helpers/pg-error";

/**
 * Phase 0 spike A-04: the exact constraint SQL from DATA_MODEL.md on a throwaway
 * table. Replaced by the real bookings tests in phase 5.
 */
describe("A-04 spike: bookings_no_overlap exclusion constraint (BR-11, BR-12)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  const spaceA = "11111111-1111-4111-8111-111111111111";
  const spaceB = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS spike CASCADE`);
    await db.execute(sql`CREATE SCHEMA spike`);
    await db.execute(sql`
      CREATE TABLE spike.bookings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        blocked_until timestamptz NOT NULL,
        status text NOT NULL CHECK (status IN ('tentative', 'confirmed', 'cancelled'))
      )`);
    await db.execute(sql`
      ALTER TABLE spike.bookings ADD CONSTRAINT bookings_no_overlap
        EXCLUDE USING gist (
          space_id WITH =,
          tstzrange(starts_at, blocked_until, '[)') WITH &&
        ) WHERE (status = 'confirmed')`);
  });

  beforeEach(() => db.execute(sql`TRUNCATE spike.bookings`));

  afterAll(async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS spike CASCADE`);
    await handle.close();
  });

  const insert = (space: string, startsAt: string, blockedUntil: string, status: string) =>
    db.execute(sql`
      INSERT INTO spike.bookings (space_id, starts_at, blocked_until, status)
      VALUES (${space}, ${startsAt}::timestamptz, ${blockedUntil}::timestamptz, ${status})
      RETURNING id`);

  // Evening party 19:00–24:00 Cairo (+03:00 in October, DST) with a 60-minute buffer.
  const evening = ["2026-10-20T19:00:00+03:00", "2026-10-21T01:00:00+03:00"] as const;

  it("rejects a second confirmed booking that partially overlaps (BR-11)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    const error = await insert(spaceA, "2026-10-20T23:00:00+03:00", "2026-10-21T03:00:00+03:00", "confirmed").catch(
      (e: unknown) => e,
    );
    expect(pgErrorCode(error)).toBe(PG_EXCLUSION_VIOLATION);
  });

  it("rejects a booking inside the buffer of the previous one (BR-10, BR-11)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    const error = await insert(spaceA, "2026-10-21T00:30:00+03:00", "2026-10-21T02:00:00+03:00", "confirmed").catch(
      (e: unknown) => e,
    );
    expect(pgErrorCode(error)).toBe(PG_EXCLUSION_VIOLATION);
  });

  it("allows back-to-back bookings when the next starts exactly at blocked_until ('[)' range)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    await expect(insert(spaceA, evening[1], "2026-10-21T05:00:00+03:00", "confirmed")).resolves.toBeDefined();
  });

  it("allows overlapping confirmed bookings in different spaces (D-02)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    await expect(insert(spaceB, ...evening, "confirmed")).resolves.toBeDefined();
  });

  it("ignores tentative and cancelled bookings (BR-12)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    await expect(insert(spaceA, ...evening, "tentative")).resolves.toBeDefined();
    await expect(insert(spaceA, ...evening, "tentative")).resolves.toBeDefined();
    await expect(insert(spaceA, ...evening, "cancelled")).resolves.toBeDefined();
  });

  it("rejects confirming a tentative booking onto a taken slot (BR-11 on update)", async () => {
    await insert(spaceA, ...evening, "confirmed");
    const tentative = await insert(spaceA, ...evening, "tentative");
    const id = (tentative.rows[0] as { id: string }).id;
    const error = await db
      .execute(sql`UPDATE spike.bookings SET status = 'confirmed' WHERE id = ${id}`)
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(PG_EXCLUSION_VIOLATION);
  });
});
