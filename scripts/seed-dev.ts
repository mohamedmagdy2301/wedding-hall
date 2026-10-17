import type { SessionUser } from "../src/modules/auth/sessions";
import { createService, type ServiceInput } from "../src/modules/catalog/services";
import { createPackage, type PackageFields } from "../src/modules/packages/service";
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
 * Adds demo settings and catalog (TESTING.md seed: 3 spaces, seasons, lists, cancellation
 * tiers, services of every kind, packages with regular and season prices and included items)
 * through the same services as the app; `--bare` stops after the venue, to walk through
 * the guided setup (S-14) from scratch.
 */
async function seedDemoSettings(deps: ServiceDeps, owner: SessionUser) {
  await updateVenue(deps, owner, { name: "قاعة تجريبية", phone: "0221234567", address: "مدينة نصر، القاهرة" });
  const slots = { day: { start: "12:00", end: "17:00" }, evening: { start: "19:00", end: "00:00" } };
  const big = await createSpace(deps, owner, { name: "القاعة الكبرى", capacityMax: 500, ...slots });
  const small = await createSpace(deps, owner, { name: "القاعة الصغرى", capacityMax: 200, ...slots });
  const roof = await createSpace(deps, owner, {
    name: "الروف",
    capacityMax: 150,
    day: { start: "13:00", end: "18:00" },
    evening: { start: "20:00", end: "02:00" },
  });
  const year = new Date().getFullYear() + 1;
  const summer = await createSeason(deps, owner, {
    name: `الصيف ${year}`,
    startDate: `${year}-06-01`,
    endDate: `${year}-08-31`,
  });
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
  await seedDemoCatalog(deps, owner, { big: big.id, small: small.id, roof: roof.id }, summer.id);
}

const pounds = (n: number) => n * 100;

/** Every category and pricing type, with and without external providers (BR-34). */
const DEMO_SERVICES: ServiceInput[] = [
  {
    name: "دي جي",
    category: "show",
    pricingType: "fixed",
    unitPrice: pounds(3000),
    allowExternal: true,
    externalFee: pounds(500),
  },
  {
    name: "فرقة زفة",
    category: "show",
    pricingType: "fixed",
    unitPrice: pounds(2500),
    allowExternal: true,
    externalFee: 0,
  },
  {
    name: "تصوير فيديو",
    category: "service",
    pricingType: "per_unit",
    unitPrice: pounds(2000),
    allowExternal: true,
    externalFee: pounds(300),
  },
  {
    name: "كوشة",
    category: "service",
    pricingType: "fixed",
    unitPrice: pounds(4000),
    allowExternal: false,
    externalFee: 0,
  },
  {
    name: "مشروب ترحيب",
    category: "hospitality",
    pricingType: "per_guest",
    unitPrice: pounds(25),
    allowExternal: false,
    externalFee: 0,
  },
  {
    name: "بوفيه عشاء",
    category: "hospitality",
    pricingType: "per_guest",
    unitPrice: pounds(250),
    allowExternal: false,
    externalFee: 0,
  },
  {
    name: "تورتة",
    category: "hospitality",
    pricingType: "per_unit",
    unitPrice: pounds(1500),
    allowExternal: true,
    externalFee: 0,
  },
];

async function seedDemoCatalog(
  deps: ServiceDeps,
  owner: SessionUser,
  spaces: { big: string; small: string; roof: string },
  summerId: string,
) {
  const ids: Record<string, string> = {};
  for (const service of DEMO_SERVICES) ids[service.name] = (await createService(deps, owner, service)).id;
  const item = (name: string, quantity = 1, removalCredit?: number) => ({
    serviceId: ids[name],
    quantity,
    removable: removalCredit !== undefined,
    removalCredit: removalCredit ?? 0,
  });
  const regular = (slotKind: "day" | "evening" | "full_day", price: number) => ({
    slotKind,
    seasonId: null,
    price: pounds(price),
  });
  const summer = (slotKind: "day" | "evening" | "full_day", price: number) => ({
    slotKind,
    seasonId: summerId,
    price: pounds(price),
  });
  const packages: (PackageFields & { spaceId: string })[] = [
    {
      spaceId: spaces.big,
      name: "الباكيج الفضي",
      description: "كوشة ودي جي ومشروب ترحيب",
      baseGuests: 300,
      extraGuestPrice: pounds(150),
      isActive: true,
      prices: [regular("day", 30000), regular("evening", 45000), summer("evening", 55000)],
      items: [item("كوشة"), item("دي جي", 1, pounds(1500)), item("مشروب ترحيب")],
    },
    {
      spaceId: spaces.big,
      name: "الباكيج الذهبي",
      description: "كل الفضي + زفة وتصوير وبوفيه",
      baseGuests: 400,
      extraGuestPrice: pounds(300),
      isActive: true,
      prices: [regular("evening", 90000), regular("full_day", 120000), summer("evening", 105000)],
      items: [
        item("كوشة"),
        item("دي جي", 1, pounds(1500)),
        item("فرقة زفة", 1, pounds(1000)),
        item("تصوير فيديو", 2, pounds(1500)),
        item("مشروب ترحيب"),
        item("بوفيه عشاء"),
      ],
    },
    {
      spaceId: spaces.small,
      name: "باكيج الخطوبة",
      description: null,
      baseGuests: 120,
      extraGuestPrice: pounds(100),
      isActive: true,
      prices: [regular("day", 12000), regular("evening", 18000)],
      items: [item("دي جي", 1, pounds(1000)), item("مشروب ترحيب")],
    },
    {
      // "Hall rent + per person" (D-79: zero base guests).
      spaceId: spaces.roof,
      name: "الروف بالفرد",
      description: "إيجار المكان + سعر الفرد",
      baseGuests: 0,
      extraGuestPrice: pounds(200),
      isActive: true,
      prices: [regular("evening", 10000), summer("evening", 14000)],
      items: [item("دي جي", 1, pounds(1000))],
    },
    {
      spaceId: spaces.roof,
      name: "مسودة باكيج",
      description: "مسودة معطّلة بلا أسعار (D-78)",
      baseGuests: 100,
      extraGuestPrice: 0,
      isActive: false,
      prices: [],
      items: [],
    },
  ];
  for (const p of packages) await createPackage(deps, owner, p);
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
