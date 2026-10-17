import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { runMigrations } from "../../scripts/migrate";
import { venues } from "../../src/db/schema";
import { E2E_DATABASE_URL, E2E_VENUE_NAME } from "./env";

/**
 * Fresh database with one known venue. Runs as part of the Playwright webServer
 * command (before the server starts), since webServer starts before globalSetup.
 */
async function prepareE2eDatabase() {
  const adminUrl = new URL(E2E_DATABASE_URL);
  const dbName = adminUrl.pathname.slice(1);
  adminUrl.pathname = "/postgres";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  await runMigrations(E2E_DATABASE_URL);

  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await drizzle({ client }).insert(venues).values({
      name: E2E_VENUE_NAME,
      bufferMinutes: 60,
      tentativeHoldHours: 48,
      minDepositType: "none",
      minDepositValue: 0,
      cancellationBasis: "deposit",
      postponeCreditMode: "refund",
    });
  } finally {
    await client.end();
  }
}

prepareE2eDatabase()
  .then(() => console.log("E2E database ready."))
  .catch((error: unknown) => {
    console.error("E2E database setup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
