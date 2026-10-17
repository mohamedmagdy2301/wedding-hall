import { parseArgs } from "node:util";
import { setupVenue } from "../src/modules/settings/setup";
import { ask, askNewPassword } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * UF-01 step 4: creates the venue, its owner, the default roles and settings (P1-01).
 * Refuses to run if a venue already exists. The owner's temporary password is typed in
 * a hidden prompt and never printed (P1-03); it must be changed at first login.
 *
 *   npm run setup-venue -- --venue-name "قاعة النور" --owner-name "أحمد" --owner-login 01012345678
 */
async function main() {
  const { values } = parseArgs({
    options: {
      "venue-name": { type: "string" },
      "owner-name": { type: "string" },
      "owner-login": { type: "string" },
    },
  });
  const venueName = values["venue-name"] ?? (await ask("Venue name: "));
  const ownerName = values["owner-name"] ?? (await ask("Owner name: "));
  const ownerLogin = values["owner-login"] ?? (await ask("Owner login (Egyptian mobile or username): "));
  const ownerTempPassword = await askNewPassword("Owner temporary password (min 8 characters, hidden)");

  const { deps, handle } = scriptDeps();
  try {
    await setupVenue(deps, { venueName, ownerName, ownerLogin, ownerTempPassword });
    console.log("Venue set up: venue, owner, default roles (مدير، استقبال/حجوزات، محاسب) and default settings.");
    console.log("The owner must change the temporary password at first login. It was not printed or logged.");
    console.log("Next for the owner: cancellation tiers are a mandatory setup step before any booking (D-60).");
  } finally {
    await handle.close();
  }
}

main().catch(fail);
