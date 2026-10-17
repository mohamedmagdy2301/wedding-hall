import type { SessionUser } from "../src/modules/auth/sessions";
import { addSuggestedItems } from "../src/modules/settings/lists";
import { createSeason } from "../src/modules/settings/seasons";
import { setupVenue } from "../src/modules/settings/setup";
import { updatePolicies, updateVenue } from "../src/modules/settings/venue";
import type { ServiceDeps } from "../src/modules/shared/context";
import { createSpace } from "../src/modules/spaces/service";
import { askNewPassword } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * Development/demo data only: a demo venue with the owner login "owner". Real venues are
 * created with `npm run setup-venue`. The temporary password is typed hidden.
 * Adds demo settings (TESTING.md seed: 3 spaces, seasons, lists, cancellation tiers)
 * through the same services as the app; `--bare` stops after the venue, to walk through
 * the guided setup (S-14) from scratch.
 */
async function seedDemoSettings(deps: ServiceDeps, owner: SessionUser) {
  await updateVenue(deps, owner, { name: "قاعة تجريبية", phone: "0221234567", address: "مدينة نصر، القاهرة" });
  const slots = { day: { start: "12:00", end: "17:00" }, evening: { start: "19:00", end: "00:00" } };
  await createSpace(deps, owner, { name: "القاعة الكبرى", capacityMax: 500, ...slots });
  await createSpace(deps, owner, { name: "القاعة الصغرى", capacityMax: 200, ...slots });
  await createSpace(deps, owner, {
    name: "الروف",
    capacityMax: 150,
    day: { start: "13:00", end: "18:00" },
    evening: { start: "20:00", end: "02:00" },
  });
  const year = new Date().getFullYear() + 1;
  await createSeason(deps, owner, { name: `الصيف ${year}`, startDate: `${year}-06-01`, endDate: `${year}-08-31` });
  await createSeason(deps, owner, { name: `الأعياد ${year}`, startDate: `${year}-03-15`, endDate: `${year}-04-05` });
  for (const kind of ["eventTypes", "paymentMethods", "expenseCategories"] as const) {
    await addSuggestedItems(deps, owner, { kind });
  }
  await updatePolicies(deps, owner, {
    minDepositType: "percent",
    minDepositValue: 1000,
    cancellationBasis: "deposit",
    postponeCreditMode: "both",
    tiers: [
      { minDaysBefore: 0, refundBps: 0 },
      { minDaysBefore: 30, refundBps: 5000 },
      { minDaysBefore: 90, refundBps: 10000 },
    ],
  });
}

async function main() {
  const bare = process.argv.includes("--bare");
  const ownerTempPassword = await askNewPassword("Demo owner temporary password (hidden)");
  const { deps, handle } = scriptDeps();
  try {
    const { venueId, ownerId } = await setupVenue(deps, {
      venueName: "قاعة تجريبية",
      ownerName: "مالك تجريبي",
      ownerLogin: "owner",
      ownerTempPassword,
    });
    if (!bare) {
      // Demo rows are recorded in the audit log as the owner's.
      const owner: SessionUser = {
        sessionId: "seed",
        userId: ownerId,
        venueId,
        name: "مالك تجريبي",
        login: "owner",
        isOwner: true,
        mustChangePassword: false,
        permissions: new Set(),
        expiresAt: new Date(),
      };
      await seedDemoSettings(deps, owner);
    }
    console.log(
      `Seeded demo venue${bare ? " (bare: no settings)" : " with demo settings"}. Sign in as "owner" with the temporary password you typed.`,
    );
  } finally {
    await handle.close();
  }
}

main().catch(fail);
