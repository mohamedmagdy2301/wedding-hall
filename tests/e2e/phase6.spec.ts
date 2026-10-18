import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { cancellationTiers, roles, userRoles, users, venues } from "../../src/db/schema";
import { addDays, cairoDate } from "../../src/lib/time";
import type { SessionUser } from "../../src/modules/auth/sessions";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { confirmBooking } from "../../src/modules/bookings/confirm";
import { createTentative } from "../../src/modules/bookings/service";
import { createService } from "../../src/modules/catalog/services";
import { createPackage } from "../../src/modules/packages/service";
import { createListItem } from "../../src/modules/settings/lists";
import { createSpace } from "../../src/modules/spaces/service";
import { E2E_DATABASE_URL, E2E_P2_PASSWORD, E2E_P2_USERS, E2E_WS_PROXY } from "./env";

/**
 * Phase 6 journeys (PHASE6_PLAN §6.6): tentative → confirmed with a deposit → installment →
 * receipt (TESTING), confirmed straight from the wizard (BR-23), voiding the deposit and its
 * replacement (D-40), collections (S-09), the accountant, and the 80 mm receipt. Prepared
 * per project through the services; dates are relative to today, in Cairo. The venue's
 * minimum deposit is set to 25% here.
 */
test.describe.configure({ mode: "serial" });

const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");
const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

type World = {
  spaceId: string;
  packageName: string;
  method: string;
  tentativeNo: string;
  voidNo: string;
  overdueNo: string;
  accountant: string;
  dates: { tentative: string; wizard: string; voided: string; overdue: string };
};

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
    const dates = {
      tentative: addDays(today, 40),
      wizard: addDays(today, 42),
      voided: addDays(today, 44),
      overdue: addDays(today, 46),
    };

    // Ready to confirm (BR-21 item 5) whatever the earlier specs left: phone, address,
    // tiers and a 25% minimum deposit.
    await db
      .update(venues)
      .set({ phone: "0223456789", address: "القاهرة", minDepositType: "percent", minDepositValue: 2500 })
      .where(eq(venues.id, actor.venueId));
    const tiers = await db.select().from(cancellationTiers).where(eq(cancellationTiers.venueId, actor.venueId));
    if (tiers.length === 0) {
      await db.insert(cancellationTiers).values({ venueId: actor.venueId, minDaysBefore: 0, refundBps: 0 });
    }
    const method = `كاش ${s}6`;
    const { id: methodId } = await createListItem(deps, actor, { kind: "paymentMethods", name: method });

    const { id: spaceId } = await createSpace(deps, actor, {
      name: `قاعة المدفوعات ${s}`,
      capacityMax: 400,
      day: { start: "13:00", end: "18:00" },
      evening: { start: "20:00", end: "01:00" },
    });
    const { id: weddingId } = await createListItem(deps, actor, {
      kind: "eventTypes",
      name: `فرح ${s}6`,
      isWedding: true,
    });
    await createService(deps, actor, {
      name: `تصوير ${s}6`,
      category: "service",
      pricingType: "per_unit",
      unitPrice: 250_000,
      allowExternal: false,
      externalFee: 0,
    });
    const packageName = `الذهبي ${s}6`;
    const { id: packageId } = await createPackage(deps, actor, {
      spaceId,
      name: packageName,
      description: null,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      isActive: true,
      prices: [{ slotKind: "evening", seasonId: null, price: 6_000_000 }],
      items: [],
    });

    const wedding = (eventDate: string, phone: string) => ({
      spaceId,
      slotKind: "evening" as const,
      startTime: null,
      endTime: null,
      eventDate,
      eventTypeId: weddingId,
      groomName: "أحمد",
      brideName: "منى",
      packageId,
      guests: 200,
      notes: null,
      items: [],
      removedServiceIds: [],
      customer: { name: `عميل المدفوعات ${s}`, phone, altPhone: null },
    });
    const confirmed = async (eventDate: string, phone: string, installments: { dueDate: string; amount: number }[]) => {
      const t = await createTentative(deps, actor, wedding(eventDate, phone));
      await confirmBooking(deps, actor, {
        bookingId: t.id,
        version: t.version,
        expectedTotal: 6_000_000,
        deposit: { amount: 1_500_000, methodId, paidAt: null },
        installments,
      });
      return t.bookingNo;
    };

    const tentative = await createTentative(
      deps,
      actor,
      wedding(dates.tentative, s === "د" ? "01277700001" : "01277700002"),
    );
    const voidNo = await confirmed(dates.voided, s === "د" ? "01277700011" : "01277700012", [
      { dueDate: addDays(today, 10), amount: 2_000_000 },
      { dueDate: addDays(today, 20), amount: 2_500_000 },
    ]);
    // An installment that fell due yesterday (old dates are allowed — D-126).
    const overdueNo = await confirmed(dates.overdue, s === "د" ? "01277700021" : "01277700022", [
      { dueDate: addDays(today, -1), amount: 2_000_000 },
      { dueDate: addDays(today, 30), amount: 2_500_000 },
    ]);

    const accountant = `p6.accountant${s === "د" ? "" : ".m"}`;
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.venueId, actor.venueId), eq(roles.name, "محاسب")));
    const [user] = await db
      .insert(users)
      .values({
        venueId: actor.venueId,
        name: accountant,
        login: accountant,
        passwordHash: hasher.hash(E2E_P2_PASSWORD),
        mustChangePassword: false,
      })
      .returning({ id: users.id });
    await db.insert(userRoles).values({ userId: user.id, roleId: role.id });

    return { spaceId, packageName, method, tentativeNo: tentative.bookingNo, voidNo, overdueNo, accountant, dates };
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

async function chooseMethod(page: Page, scope: ReturnType<Page["getByTestId"]>) {
  await scope.getByTestId("payment-method").click();
  await page.getByRole("option", { name: world.method }).click();
}

test("P6-E1: a tentative booking is confirmed with a deposit and a schedule, an installment is paid, and its receipt prints at 80 mm (BR-21, BR-65, P-04)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await openBooking(page, world.tentativeNo);
  await page.getByTestId("confirm-booking").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog.getByTestId("confirm-total")).toContainText("٦٠٬٠٠٠");
  // Prefilled with the 25% minimum (D-119).
  await expect(dialog.getByTestId("deposit-amount")).toHaveValue("15000");
  await chooseMethod(page, dialog);
  await dialog.getByTestId("add-installment").click();
  await dialog.getByTestId("installment-date-0").fill(addDays(cairoDate(new Date()), 15));
  await dialog.getByTestId("fill-last").click();
  await expect(dialog.getByTestId("installment-amount-0")).toHaveValue("45000");
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-status")).toHaveText("مؤكد");
  await expect(page.getByTestId("booking-balance")).toContainText("١٥٬٠٠٠");

  await page.getByTestId("tab-payments").click();
  await expect(page.getByTestId("schedule-table")).toContainText("٤٥٬٠٠٠");
  await page.getByTestId("record-payment").click();
  const pay = page.getByTestId("record-payment-dialog");
  await pay.getByTestId("payment-amount").fill("20000");
  await chooseMethod(page, pay);
  await pay.getByTestId("record-submit").click();
  await expect(pay).toBeHidden();
  await expect(page.getByTestId("ledger-remaining")).toContainText("٢٥٬٠٠٠");
  await expect(page.getByTestId("payments-table").locator("tbody tr")).toHaveCount(2);

  // The installment's receipt on an 80 mm page: nothing wider than the paper (P-04).
  const href = await page
    .getByTestId("payments-table")
    .locator("tbody tr")
    .last()
    .getByTestId("print-80")
    .getAttribute("href");
  await page.setViewportSize({ width: 302, height: 900 }); // 80 mm at 96 dpi
  await page.goto(href!);
  const receipt = page.getByTestId("receipt");
  await expect(receipt).toHaveAttribute("data-size", "80");
  await expect(receipt).toContainText("قسط");
  await expect(receipt).toContainText("٢٠٬٠٠٠");
  await expect(receipt).toContainText("٣٥٬٠٠٠"); // paid as of this receipt
  await page.emulateMedia({ media: "print" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const pdf = await page.pdf({ width: "80mm", printBackground: true });
  expect(pdf.byteLength).toBeGreaterThan(1000);
});

test("P6-E2: the wizard saves a booking confirmed at once with its deposit (BR-23)", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings/new?space=${world.spaceId}&date=${world.dates.wizard}&slot=evening`);
  await page.getByRole("button", { name: /المناسبة والباكيج/ }).click();
  await page.getByTestId("wizard-event-type").click();
  await page.getByRole("option", { name: `فرح ${suffix(info)}6` }).click();
  await page.getByTestId("wizard-package").click();
  await page.getByRole("option", { name: world.packageName }).click();
  await page.getByTestId("wizard-guests").fill("200");
  await page
    .getByRole("button", { name: /العميل/ })
    .first()
    .click();
  await page.getByTestId("customer-phone").fill(info.project.name === "desktop" ? "01277700031" : "01277700032");
  await page.getByTestId("customer-name").fill(`عميل مؤكد ${suffix(info)}`);
  await page.getByLabel("اسم العريس").fill("كريم");
  await page.getByLabel("اسم العروسة").fill("سارة");
  await page.getByTestId("wizard-confirm").click();
  const dialog = page.getByTestId("confirm-dialog");
  await chooseMethod(page, dialog);
  await dialog.getByTestId("confirm-submit").click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("booking-status")).toHaveText("مؤكد");
});

test("P6-E3: the manager voids the deposit, the booking stays confirmed with a warning, and a replacement deposit below the minimum is warned about and clears it (BR-64, D-40, D-121, R6-02)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.voidNo);
  await page.getByTestId("tab-payments").click();
  await page.getByTestId("void-payment").first().click();
  const dialog = page.getByTestId("void-dialog");
  await dialog.getByTestId("void-reason").fill("الشيك رجع");
  await dialog.getByTestId("void-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-status")).toHaveText("مؤكد");
  await expect(page.getByTestId("deposit-missing")).toBeVisible();

  await page.getByTestId("record-deposit").click();
  const replacement = page.getByTestId("record-deposit-dialog");
  await replacement.getByTestId("deposit-amount").fill("10000");
  // Below the 25% minimum (15,000): a warning, not a block (R6-02).
  await expect(replacement.getByTestId("below-minimum")).toBeVisible();
  await chooseMethod(page, replacement);
  // 5,000 more on the last installment (I-07).
  await expect(replacement.getByTestId("rebalance-preview")).toContainText("٣٠٬٠٠٠");
  await replacement.getByTestId("deposit-submit").click();
  await expect(replacement).toBeHidden();
  await expect(page.getByTestId("deposit-missing")).toHaveCount(0);
  await expect(page.getByTestId("schedule-table")).toContainText("٣٠٬٠٠٠");
});

test("P6-E4: collections show the overdue installment and record a payment from its row (S-09, BR-66, UF-05)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto("/collections");
  const row = page.getByTestId("collection-row").filter({ hasText: world.overdueNo });
  await expect(row).toContainText("متأخر");
  await row.getByTestId("collect").click();
  const dialog = page.getByTestId("record-payment-dialog");
  await dialog.getByTestId("payment-amount").fill("20000");
  await chooseMethod(page, dialog);
  await dialog.getByTestId("record-submit").click();
  await expect(page.getByTestId("payment-recorded")).toBeVisible();
  await expect(page.getByTestId("collection-row").filter({ hasText: world.overdueNo })).toHaveCount(0);
});

test("P6-E5: the accountant confirms and records but cannot void; the booking list shows what is owed", async ({
  page,
}) => {
  await signIn(page, world.accountant);
  await openBooking(page, world.voidNo);
  await page.getByTestId("tab-payments").click();
  await expect(page.getByTestId("record-payment")).toBeVisible();
  await expect(page.getByTestId("void-payment")).toHaveCount(0);
  await page.goto(`/bookings?search=${world.voidNo}&balance=due`);
  await expect(page.getByTestId("booking-row").getByTestId("booking-remaining")).toContainText("٥٠٬٠٠٠");
});
