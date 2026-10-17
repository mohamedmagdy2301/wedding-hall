import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { connectTestDb } from "./helpers/db";

describe("database infrastructure", () => {
  const handle = connectTestDb();
  afterAll(() => handle.close());

  it("runs PostgreSQL 17", async () => {
    const result = await handle.db.execute<{ version: string }>(
      sql`select current_setting('server_version') as version`,
    );
    expect(result.rows[0].version).toMatch(/^17\./);
  });

  it("has btree_gist enabled by the first migration (A-04, BR-11 prerequisite)", async () => {
    const result = await handle.db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'btree_gist'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it("stores timestamps as timestamptz", async () => {
    const result = await handle.db.execute<{ data_type: string }>(
      sql`select data_type from information_schema.columns
          where table_name = 'venues' and column_name = 'created_at'`,
    );
    expect(result.rows[0].data_type).toBe("timestamp with time zone");
  });
});
