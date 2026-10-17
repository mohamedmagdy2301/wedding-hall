import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { venues } from "../src/db/schema";
import { requireEnv } from "./lib/load-env";

// Development/demo data only. Real venues are created by `setup-venue` (phase 1).
async function main() {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL") });
  await client.connect();
  try {
    const db = drizzle({ client });
    const existing = await db.select({ id: venues.id }).from(venues).limit(1);
    if (existing.length > 0) {
      console.log("Seed skipped: a venue already exists.");
      return;
    }
    await db.insert(venues).values({
      name: "قاعة تجريبية",
      bufferMinutes: 60,
      tentativeHoldHours: 48,
      minDepositType: "none",
      minDepositValue: 0,
      cancellationBasis: "deposit",
      postponeCreditMode: "refund",
    });
    console.log("Seeded demo venue.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
