import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDb } from "../helpers/db";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "../helpers/pg-error";

/**
 * Phase 0 spike A-05 (local half): interactive transaction through the Neon
 * serverless driver. The Workers half runs on the deployed spike route.
 */
describe("A-05 spike: interactive transaction rollback", () => {
  const handle = connectTestDb();
  const db = handle.db;

  beforeAll(async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS spike_tx CASCADE`);
    await db.execute(sql`CREATE SCHEMA spike_tx`);
    await db.execute(sql`CREATE TABLE spike_tx.items (id int PRIMARY KEY, label text NOT NULL)`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS spike_tx CASCADE`);
    await handle.close();
  });

  it("rolls back the first write when the second fails", async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (1, 'first')`);
        // A read inside the transaction sees the uncommitted row (interactive, not batched).
        const seen = await tx.execute(sql`SELECT count(*)::int AS n FROM spike_tx.items`);
        expect((seen.rows[0] as { n: number }).n).toBe(1);
        await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (1, 'duplicate')`);
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_UNIQUE_VIOLATION);
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM spike_tx.items`);
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });

  it("commits both writes when nothing fails", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (10, 'a')`);
      await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (11, 'b')`);
    });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM spike_tx.items`);
    expect((after.rows[0] as { n: number }).n).toBe(2);
  });
});
