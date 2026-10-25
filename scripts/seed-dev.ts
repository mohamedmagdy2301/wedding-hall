import { addDays, cairoDate } from "../src/lib/time";
import type { SessionUser } from "../src/modules/auth/sessions";
import { previewItems, updateItems } from "../src/modules/bookings/amend";
import { cancelBooking, cancelPreview } from "../src/modules/bookings/cancel";
import { confirmBooking } from "../src/modules/bookings/confirm";
import { insertDiscount } from "../src/modules/discounts/service";
import { postponeBooking, postponePreview } from "../src/modules/bookings/postpone";
import { createTentative } from "../src/modules/bookings/service";
import { createService, type ServiceInput } from "../src/modules/catalog/services";
import { createPackage, type PackageFields } from "../src/modules/packages/service";
import { addSuggestedItems, listItems } from "../src/modules/settings/lists";
import { createSeason } from "../src/modules/settings/seasons";
import { setupVenue } from "../src/modules/settings/setup";
import { updatePolicies, updateVenue } from "../src/modules/settings/venue";
import type { ServiceDeps } from "../src/modules/shared/context";
import { createSpace } from "../src/modules/spaces/service";
import { uploadDocument } from "../src/modules/documents/service";
import { createExpense, voidExpense } from "../src/modules/expenses/service";
import { setLogo } from "../src/modules/settings/logo";
import { ensureLocalBucket, LOCAL_FILE_STORE } from "../src/lib/r2";
import { demoIdCard, demoLogo, demoPdf } from "./lib/demo-files";
import { askNewPassword } from "./lib/prompt";
import { fail, scriptDeps } from "./lib/services";

/**
 * Development/demo data only: a demo venue with the owner login "owner". Real venues are
 * created with `npm run setup-venue`. The temporary password is typed hidden.
 * Adds demo settings and catalog (TESTING.md seed: 3 spaces, seasons, lists, cancellation
 * tiers, services of every kind, packages with regular and season prices and included items)
 * through the same services as the app; `--bare` stops after the venue, to walk through
 * the guided setup (S-14) from scratch.
 * Phase 5 adds demo tentative bookings (one expired, two on the same slot, two customers
 * with one number — D-28); phase 6 two confirmed ones with their deposit, one with a
 * schedule whose first installment is overdue (P6-12), through bookings.confirm. Phase 7 a
 * guest change and a pending discount; phase 8 a booking postponed into the summer season and
 * one cancelled with the refund its tiers suggest (P8-10); phases 9 and 10 the logo, two
 * documents and expenses — one on a booking, one on the cancelled booking, one voided (P9-11).
 * Files go to R2 when it is configured, or to the local stand-in for a local database;
 * otherwise the logo and documents are skipped.
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
  const spaces = { big: big.id, small: small.id, roof: roof.id };
  const packages = await seedDemoCatalog(deps, owner, spaces, summer.id);
  await seedDemoBookings(deps, owner, spaces, packages);
  await seedDemoConfirmed(deps, owner, spaces, packages);
}

/** Confirmed bookings through the same service as the app (D-97), with deposits and a schedule. */
async function seedDemoConfirmed(
  deps: ServiceDeps,
  owner: SessionUser,
  spaces: { big: string; small: string; roof: string },
  packages: Record<string, string>,
) {
  const today = cairoDate(deps.now);
  const eventTypes = await listItems(deps.db, owner, "eventTypes");
  const typeId = (name: string) => eventTypes.find((e) => e.name === name)?.id ?? null;
  const [method] = (await listItems(deps.db, owner, "paymentMethods")).filter((m) => m.isActive);
  const confirmed = async (
    input: Pick<Parameters<typeof createTentative>[2], "spaceId" | "eventDate" | "slotKind" | "packageId" | "guests">,
    customer: { name: string; phone: string },
    names: { groomName: string | null; brideName: string | null; eventType: string },
    schedule: (total: number, deposit: number) => { dueDate: string; amount: number }[],
  ) => {
    const tentative = await createTentative(deps, owner, {
      startTime: null,
      endTime: null,
      notes: null,
      items: [],
      removedServiceIds: [],
      ...input,
      ...names,
      eventTypeId: typeId(names.eventType),
      customer: { ...customer, altPhone: null },
    });
    const row = await deps.db.query.bookings.findFirst({
      columns: { total: true },
      where: (b, { eq }) => eq(b.id, tentative.id),
    });
    const total = row!.total!;
    const deposit = Math.round(total / 4);
    await confirmBooking(deps, owner, {
      bookingId: tentative.id,
      version: tentative.version,
      expectedTotal: total,
      deposit: { amount: deposit, methodId: method.id, paidAt: null },
      installments: schedule(total, deposit),
    });
    return { id: tentative.id, bookingNo: tentative.bookingNo };
  };

  // Its first installment fell due three days ago: overdue in collections (BR-66).
  const silver = await confirmed(
    {
      spaceId: spaces.big,
      eventDate: addDays(today, 45),
      slotKind: "evening",
      packageId: packages["الباكيج الفضي"],
      guests: 300,
    },
    { name: "هاني فؤاد", phone: "01006667788" },
    { groomName: "هاني", brideName: "نورا", eventType: "فرح" },
    (total, deposit) => {
      const first = Math.round(total / 3);
      return [
        { dueDate: addDays(today, -3), amount: first },
        { dueDate: addDays(today, 40), amount: total - deposit - first },
      ];
    },
  );
  const engagement = await confirmed(
    {
      spaceId: spaces.small,
      eventDate: addDays(today, 60),
      slotKind: "day",
      packageId: packages["باكيج الخطوبة"],
      guests: 120,
    },
    { name: "منة الله سمير", phone: "01117778899" },
    { groomName: null, brideName: null, eventType: "خطوبة" },
    () => [],
  );

  // Phase 7 (P7-08): 20 guests added after confirmation (D-92), and a pending discount for S-10.
  const changes = {
    guests: 320,
    extraGuestUnitPrice: null,
    guestServicePrices: [],
    add: [],
    remove: [],
    quantities: [],
    removeIncluded: [],
    restoreIncluded: [],
  };
  const preview = await previewItems(deps.db, owner, { bookingId: silver.id, changes });
  await updateItems(deps, owner, {
    bookingId: silver.id,
    version: preview.version,
    expectedTotal: preview.totalAfter,
    changes,
    overrideReason: null,
    credit: null,
  });
  await deps.db.transaction((tx) =>
    insertDiscount(tx, owner, deps.now, engagement, {
      bookingId: engagement.id,
      amount: 100_000,
      reason: "عميل قديم (تجريبي)",
      source: "request",
      approved: false,
    }),
  );

  // Phase 8 (P8-10): postponed into the summer season when it is ahead, and cancelled with its suggested refund.
  const moved = await confirmed(
    {
      spaceId: spaces.big,
      eventDate: addDays(today, 30),
      slotKind: "evening",
      packageId: packages["الباكيج الفضي"],
      guests: 250,
    },
    { name: "كريم عادل", phone: "01009990011" },
    { groomName: "كريم", brideName: "ياسمين", eventType: "فرح" },
    () => [],
  );
  const seasons = await deps.db.query.seasons.findMany({ columns: { name: true, startDate: true } });
  const summer = seasons.find((x) => x.name.startsWith("الصيف") && x.startDate > addDays(today, 31));
  const target = {
    bookingId: moved.id,
    eventDate: summer ? addDays(summer.startDate, 14) : addDays(today, 90),
    slotKind: "evening" as const,
    startTime: null,
    endTime: null,
  };
  const postponed = await postponePreview(deps.db, owner, target, deps.now);
  await postponeBooking(deps, owner, {
    ...target,
    version: postponed.version,
    expectedTotal: postponed.totalAfter,
    credit: null,
  });
  const dropped = await confirmed(
    {
      spaceId: spaces.small,
      eventDate: addDays(today, 100),
      slotKind: "evening",
      packageId: packages["باكيج الخطوبة"],
      guests: 100,
    },
    { name: "سلمى رأفت", phone: "01224445566" },
    { groomName: null, brideName: null, eventType: "خطوبة" },
    () => [],
  );
  const quote = await cancelPreview(deps.db, owner, dropped.id, deps.now);
  const suggested = quote.status === "confirmed" ? quote.suggested : 0;
  await cancelBooking(deps, owner, {
    bookingId: dropped.id,
    version: quote.version,
    reason: "العميل غيّر الميعاد لمكان تاني (تجريبي)",
    refundAmount: suggested,
    methodId: suggested > 0 ? method.id : null,
    adjustReason: null,
  });

  await seedDemoFilesAndExpenses(deps, owner, { moved, dropped, today });
}

/** Phases 9 and 10 (P9-11). */
async function seedDemoFilesAndExpenses(
  deps: ServiceDeps,
  owner: SessionUser,
  bookings: { moved: { id: string; bookingNo: string }; dropped: { id: string; bookingNo: string }; today: string },
) {
  if (deps.files) {
    if (process.env.R2_ENDPOINT === undefined) await ensureLocalBucket(LOCAL_FILE_STORE);
    await setLogo(deps, owner, { file: new Blob([demoLogo()], { type: "image/png" }) });
    await uploadDocument(deps, owner, {
      bookingId: bookings.moved.id,
      kind: "national_id",
      file: new Blob([demoIdCard()], { type: "image/png" }),
    });
    await uploadDocument(deps, owner, {
      bookingId: bookings.moved.id,
      kind: "signed_contract",
      file: new Blob([demoPdf("Signed contract (demo)")], { type: "application/pdf" }),
    });
  } else {
    console.log("No R2 for this database: the demo logo and documents are skipped.");
  }

  const categories = (await listItems(deps.db, owner, "expenseCategories")).filter((c) => c.isActive);
  const category = (i: number) => categories[i % categories.length].id;
  const { today } = bookings;
  await createExpense(deps, owner, {
    categoryId: category(0),
    amount: 250_000,
    spentOn: today,
    description: "فرقة إضافية للحفلة (تجريبي)",
    bookingNo: bookings.moved.bookingNo,
  });
  await createExpense(deps, owner, {
    categoryId: category(1),
    amount: 50_000,
    spentOn: addDays(today, -2),
    description: "تعويض مورد بعد الإلغاء (تجريبي)",
    bookingNo: bookings.dropped.bookingNo,
  });
  await createExpense(deps, owner, {
    categoryId: category(2),
    amount: 80_000,
    spentOn: addDays(today, -5),
    description: "صيانة التكييف (تجريبي)",
    bookingNo: null,
  });
  const wrong = await createExpense(deps, owner, {
    categoryId: category(0),
    amount: 120_000,
    spentOn: addDays(today, -1),
    description: "مصروف اتسجل مرتين (تجريبي)",
    bookingNo: null,
  });
  await voidExpense(deps, owner, { expenseId: wrong.id, reason: "اتسجل مرتين" });
}

/** Tentative bookings through the same service as the wizard, dated from today. */
async function seedDemoBookings(
  deps: ServiceDeps,
  owner: SessionUser,
  spaces: { big: string; small: string; roof: string },
  packages: Record<string, string>,
) {
  const today = cairoDate(deps.now);
  const eventTypes = await listItems(deps.db, owner, "eventTypes");
  const typeId = (name: string) => eventTypes.find((e) => e.name === name)?.id ?? null;
  const services = await deps.db.query.services.findMany({ columns: { id: true, name: true } });
  const serviceId = (name: string) => services.find((x) => x.name === name)!.id;
  const base = {
    startTime: null,
    endTime: null,
    groomName: null,
    brideName: null,
    notes: null,
    items: [],
    removedServiceIds: [],
  };
  const book = (
    input: Partial<Parameters<typeof createTentative>[2]> & { spaceId: string; eventDate: string },
    at = deps.now,
  ) =>
    createTentative({ ...deps, now: at }, owner, {
      ...base,
      slotKind: "evening",
      eventTypeId: null,
      packageId: null,
      guests: null,
      customer: { name: "عميل تجريبي", phone: "01000000000", altPhone: null },
      ...input,
    });

  const first = await book({
    spaceId: spaces.big,
    eventDate: addDays(today, 10),
    eventTypeId: typeId("فرح"),
    groomName: "محمد",
    brideName: "منى",
    packageId: packages["الباكيج الفضي"],
    guests: 320,
    customer: { name: "محمد أحمد", phone: "01001112233", altPhone: null },
  });
  // Another tentative booking on the same slot (D-08).
  await book({
    spaceId: spaces.big,
    eventDate: addDays(today, 10),
    customer: { name: "سارة محمود", phone: "01112223344", altPhone: null },
  });
  // A second customer with the first one's number (D-28).
  await book({
    spaceId: spaces.small,
    eventDate: addDays(today, 14),
    slotKind: "day",
    eventTypeId: typeId("خطوبة"),
    packageId: packages["باكيج الخطوبة"],
    guests: 100,
    customer: { name: "أحمد علي", phone: "01001112233", altPhone: null },
  });
  await book({
    spaceId: spaces.roof,
    eventDate: addDays(today, 20),
    eventTypeId: typeId("عيد ميلاد"),
    packageId: packages["الروف بالفرد"],
    guests: 80,
    removedServiceIds: [serviceId("دي جي")],
    items: [
      { serviceId: serviceId("دي جي"), quantity: 1, isExternal: true },
      { serviceId: serviceId("تورتة"), quantity: 2, isExternal: false },
    ],
    customer: { name: "ياسمين حسن", phone: "01223334455", altPhone: null },
  });
  // Saved three days ago with the default 48-hour hold: shown as expired.
  await book(
    {
      spaceId: spaces.big,
      eventDate: addDays(today, 30),
      slotKind: "full_day",
      packageId: packages["الباكيج الذهبي"],
      guests: 450,
      customer: { name: "كريم سامي", phone: "01554445566", altPhone: null },
    },
    new Date(deps.now.getTime() - 72 * 3_600_000),
  );
  return first;
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
  const created: Record<string, string> = {};
  for (const p of packages) created[p.name] = (await createPackage(deps, owner, p)).id;
  return created;
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
