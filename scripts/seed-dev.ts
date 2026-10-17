import { setupVenue } from "../src/modules/settings/setup";
import { askNewPassword } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * Development/demo data only: a demo venue with the owner login "owner". Real venues are
 * created with `npm run setup-venue`. The temporary password is typed hidden.
 */
async function main() {
  const ownerTempPassword = await askNewPassword("Demo owner temporary password (hidden)");
  const { deps, handle } = scriptDeps();
  try {
    await setupVenue(deps, {
      venueName: "قاعة تجريبية",
      ownerName: "مالك تجريبي",
      ownerLogin: "owner",
      ownerTempPassword,
    });
    console.log('Seeded demo venue. Sign in as "owner" with the temporary password you typed.');
  } finally {
    await handle.close();
  }
}

main().catch(fail);
