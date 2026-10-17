import { sql } from "drizzle-orm";
import { getDb } from "@/db/request";
import { notFound, spikeAuthorized } from "../guard";

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A-05: two writes in one interactive transaction on Workers; the failing second must undo the first. */
export async function POST(request: Request) {
  if (!spikeAuthorized(request)) return notFound();
  const db = getDb();
  const started = Date.now();

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS spike_tx`);
  await db.execute(sql`DROP TABLE IF EXISTS spike_tx.items`);
  await db.execute(sql`CREATE TABLE spike_tx.items (id int PRIMARY KEY, label text NOT NULL)`);

  let rowsSeenInsideTx: number | null = null;
  const failure = await db
    .transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (1, 'first')`);
      const seen = await tx.execute(sql`SELECT count(*)::int AS n FROM spike_tx.items`);
      rowsSeenInsideTx = (seen.rows[0] as { n: number }).n;
      await tx.execute(sql`INSERT INTO spike_tx.items (id, label) VALUES (1, 'duplicate')`);
    })
    .then(() => null)
    .catch((error: unknown) => pgCode(error) ?? "unknown");

  const after = await db.execute(sql`SELECT count(*)::int AS n FROM spike_tx.items`);
  const rowsAfterRollback = (after.rows[0] as { n: number }).n;
  await db.execute(sql`DROP SCHEMA spike_tx CASCADE`);

  return Response.json({
    passed: failure === "23505" && rowsSeenInsideTx === 1 && rowsAfterRollback === 0,
    secondInsertError: failure,
    rowsSeenInsideTx,
    rowsAfterRollback,
    elapsedMs: Date.now() - started,
  });
}
