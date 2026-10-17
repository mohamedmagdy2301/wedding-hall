import { eq } from "drizzle-orm";
import { Client } from "pg";
import { runMigrations } from "../../scripts/migrate";
import { createDb } from "../../src/db/client";
import { users } from "../../src/db/schema";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { setupVenue } from "../../src/modules/settings/setup";
import { E2E_DATABASE_URL, E2E_OWNERS, E2E_TEMP_PASSWORD, E2E_VENUE_NAME, E2E_WS_PROXY } from "./env";

/**
 * Fresh database set up exactly like a new venue (setup-venue), plus a second owner so
 * each Playwright project has its own account. Runs as part of the webServer command
 * (before the server starts), since webServer starts before globalSetup.
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

  const handle = createDb(E2E_DATABASE_URL, { localWsProxy: E2E_WS_PROXY || undefined });
  try {
    const hasher = createPasswordHasher(loadArgon2ModuleFromDisk(), OWASP_DEFAULT);
    const { venueId } = await setupVenue(
      { db: handle.db, hasher, now: new Date() },
      {
        venueName: E2E_VENUE_NAME,
        ownerName: E2E_OWNERS.desktop.name,
        ownerLogin: E2E_OWNERS.desktop.login,
        ownerTempPassword: E2E_TEMP_PASSWORD,
      },
    );
    const [second] = await handle.db
      .insert(users)
      .values({
        venueId,
        name: E2E_OWNERS.mobile.name,
        login: E2E_OWNERS.mobile.login,
        passwordHash: hasher.hash(E2E_TEMP_PASSWORD),
        mustChangePassword: true,
      })
      .returning({ id: users.id });
    await handle.db.update(users).set({ isOwner: true }).where(eq(users.id, second.id));
  } finally {
    await handle.close();
  }
}

prepareE2eDatabase()
  .then(() => console.log("E2E database ready."))
  .catch((error: unknown) => {
    console.error("E2E database setup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
