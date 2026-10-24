import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { cancellationTiers, packages, services, users, venues } from "../../src/db/schema";
import { addDays, cairoDate } from "../../src/lib/time";
import type { SessionUser } from "../../src/modules/auth/sessions";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { confirmBooking } from "../../src/modules/bookings/confirm";
import { createTentative } from "../../src/modules/bookings/service";
import { createService } from "../../src/modules/catalog/services";
import { createPackage } from "../../src/modules/packages/service";
import { recordPayment } from "../../src/modules/payments/service";
import { createListItem } from "../../src/modules/settings/lists";
import { createSpace } from "../../src/modules/spaces/service";
import { E2E_DATABASE_URL, E2E_P2_PASSWORD, E2E_P2_USERS, E2E_WS_PROXY } from "./env";

/**
 * Phase 7 journeys (PHASE7_PLAN §4): editing a confirmed booking with a price typed below the
 * current one (GA-04), a discount request approved on S-10 (UF-06), and a fully paid booking
 * whose kosha comes off, refunding the credit in the same operation (IT-04). The bookings:
 * 60,000 for 200 guests + kosha 4,000 + a drink 20 × 200 = 68,000, deposit 17,000; then the
 * catalog moves to 180 per extra guest and 25 per drink. The venue's policy is `refund`.
 */
test.describe.configure({ mode: "serial" });

const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");
const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

type World = { amendNo: string; paidNo: string; method: string };
let world: World;

async function prepare(info: TestInfo): Promise<World> {
  const s = suffix(info);
  const handle = createDb(E2E_DATABASE_URL, { localWsProxy: E2E_WS_PROXY || undefined });
  try {
    const db = handle.db;
    const [owner] = await db
      .select({ id: users.id, venueId: users.venueId, name: users.name, login: users.login })
      .from(users)
      .where(eq(users.login, usersOf(info).owner));
    const actor: SessionUser = {
      sessionId: "e2e",
      userId: owner.id,
      venueId: owner.venueId,
      name: owner.name,
      login: owner.login,
      isOwner: true,
      mustChangePassword: false,
      permissions: new Set(),
      expiresAt: new Date(),
    };
    const hasher = createPasswordHasher(loadArgon2ModuleFromDisk(), OWASP_DEFAULT);
    const deps = { db, hasher, now: new Date() };
    const today = cairoDate(deps.now);

    await db
      .update(venues)
      .set({
        phone: "0223456789",
        address: "القاهرة",
        minDepositType: "percent",
        minDepositValue: 2500,
        postponeCreditMode: "refund",
      })
      .where(eq(venues.id, actor.venueId));
    const tiers = await db.select().from(cancellationTiers).where(eq(cancellationTiers.venueId, actor.venueId));
    if (tiers.length === 0) {
      await db.insert(cancellationTiers).values({ venueId: actor.venueId, minDaysBefore: 0, refundBps: 0 });
    }
    const method = `كاش ${s}7`;
    const { id: methodId } = await createListItem(deps, actor, { kind: "paymentMethods", name: method });
    const { id: spaceId } = await createSpace(deps, actor, {
      name: `قاعة التعديل ${s}`,
      capacityMax: 400,
      day: { start: "13:00", end: "18:00" },
      evening: { start: "20:00", end: "01:00" },
    });
    const { id: weddingId } = await createListItem(deps, actor, {
      kind: "eventTypes",
      name: `فرح ${s}7`,
      isWedding: true,
    });
    const service = (name: string, pricingType: "fixed" | "per_guest", unitPrice: number) =>
      createService(deps, actor, {
        name,
        category: "service",
        pricingType,
        unitPrice,
        allowExternal: false,
        externalFee: 0,
      });
    const { id: koshaId } = await service(`كوشة ${s}7`, "fixed", 400_000);
    const { id: drinkId } = await service(`مشروب ${s}7`, "per_guest", 2_000);
    const { id: packageId } = await createPackage(deps, actor, {
      spaceId,
      name: `الذهبي ${s}7`,
      description: null,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      isActive: true,
      prices: [{ slotKind: "evening", seasonId: null, price: 6_000_000 }],
      items: [],
    });

    const confirmed = async (eventDate: string, phone: string) => {
      const t = await createTentative(deps, actor, {
        spaceId,
        slotKind: "evening",
        startTime: null,
        endTime: null,
        eventDate,
        eventTypeId: weddingId,
        groomName: "أحمد",
        brideName: "منى",
        packageId,
        guests: 200,
        notes: null,
        items: [
          { serviceId: koshaId, quantity: 1, isExternal: false },
          { serviceId: drinkId, quantity: 1, isExternal: false },
        ],
        removedServiceIds: [],
        customer: { name: `عميل التعديل ${s}`, phone, altPhone: null },
      });
      await confirmBooking(deps, actor, {
        bookingId: t.id,
        version: t.version,
        expectedTotal: 6_800_000,
        deposit: { amount: 1_700_000, methodId, paidAt: null },
        installments: [],
      });
      return { id: t.id, bookingNo: t.bookingNo };
    };
    const amend = await confirmed(addDays(today, 50), s === "د" ? "01288800001" : "01288800002");
    const paid = await confirmed(addDays(today, 52), s === "د" ? "01288800011" : "01288800012");
    await recordPayment(deps, actor, { bookingId: paid.id, amount: 5_100_000, methodId, paidAt: null, note: null });

    // After confirmation the catalog moves (D-92).
    await db.update(packages).set({ extraGuestPrice: 18_000 }).where(eq(packages.id, packageId));
    await db.update(services).set({ unitPrice: 2_500 }).where(eq(services.id, drinkId));
    return { amendNo: amend.bookingNo, paidNo: paid.bookingNo, method };
  } finally {
    await handle.close();
  }
}

test.beforeAll(async ({}, info) => {
  world = await prepare(info);
});

async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(E2E_P2_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openBooking(page: Page, bookingNo: string) {
  await page.goto(`/bookings?search=${bookingNo}`);
  await page.getByRole("link", { name: bookingNo }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
}

test("P7-E1: the reception adds 30 guests at a typed 160 — the total is 74,150 and a 600 discount waits; then asks 1,000 more (GA-04, BR-41, BR-50)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await openBooking(page, world.amendNo);
  await page.getByTestId("amend-booking").click();
  const dialog = page.getByTestId("amend-dialog");
  await dialog.getByTestId("amend-guests").fill("230");
  await dialog.getByTestId("amend-extra-price").fill("160");
  const preview = dialog.getByTestId("amend-preview");
  await expect(preview.getByTestId("amend-total-after")).toContainText("٧٤٬١٥٠");
  await expect(preview).toContainText("٦٠٠");
  await dialog.getByTestId("amend-override-reason").fill("اتفاق مع العميل");
  await dialog.getByTestId("amend-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-total")).toContainText("٧٤٬١٥٠");

  await page.getByRole("tab", { name: "البنود والتسعير" }).click();
  const discounts = page.getByTestId("discounts-table");
  await expect(discounts.locator("tbody tr")).toHaveCount(1);
  await expect(discounts).toContainText("معلق");
  await page.getByTestId("request-discount").click();
  const request = page.getByTestId("request-discount-dialog");
  await request.getByTestId("discount-amount").fill("1000");
  await request.getByTestId("discount-reason").fill("عميل قديم");
  await request.getByTestId("discount-submit").click();
  await expect(request).toBeHidden();
  await expect(discounts.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("booking-total")).toContainText("٧٤٬١٥٠"); // BR-50
});

test("P7-E2: the manager approves the 1,000 and rejects the 600 on the approvals screen (S-10, UF-06)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await page.getByRole("link", { name: "الموافقات" }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  const rows = page.getByTestId("approvals-table").locator(`tr[data-booking="${world.amendNo}"]`);
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "١٬٠٠٠" }).getByTestId("approve-discount").click();
  await page.getByTestId("decide-submit").click();
  await expect(page.getByTestId("decide-discount-dialog")).toBeHidden();
  await expect(rows).toHaveCount(1);
  await rows.getByTestId("reject-discount").click();
  await page.getByTestId("decide-submit").click();
  await expect(rows).toHaveCount(0);

  await openBooking(page, world.amendNo);
  await expect(page.getByTestId("booking-total")).toContainText("٧٣٬١٥٠");
});

test("P7-E3: on a booking paid in full, the manager takes the kosha off and refunds the 4,000 credit at once (IT-04, BR-83)", async ({
  page,
}) => {
  await signIn(page, usersOf(test.info()).manager);
  await openBooking(page, world.paidNo);
  await page.getByTestId("amend-booking").click();
  const dialog = page.getByTestId("amend-dialog");
  await dialog.getByTestId("amend-added").filter({ hasText: "كوشة" }).getByTestId("amend-remove").click();
  const preview = dialog.getByTestId("amend-preview");
  await expect(preview.getByTestId("amend-total-after")).toContainText("٦٤٬٠٠٠");
  const credit = dialog.getByTestId("credit-choice");
  await expect(credit).toContainText("٤٬٠٠٠");
  await credit.getByTestId("payment-method").click();
  await page.getByRole("option", { name: world.method }).click();
  await dialog.getByTestId("amend-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-total")).toContainText("٦٤٬٠٠٠");
  await page.getByTestId("tab-payments").click();
  await expect(page.getByTestId("payments-table")).toContainText("استرداد");
  await expect(page.getByTestId("ledger-remaining")).toContainText("٠");
});
