import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { cancellationTiers, users, venues } from "../../src/db/schema";
import { createFileStore, LOCAL_FILE_STORE } from "../../src/lib/r2";
import { addDays, cairoDate } from "../../src/lib/time";
import type { SessionUser } from "../../src/modules/auth/sessions";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { confirmBooking } from "../../src/modules/bookings/confirm";
import { createTentative } from "../../src/modules/bookings/service";
import { createPackage } from "../../src/modules/packages/service";
import { setLogo } from "../../src/modules/settings/logo";
import { createListItem } from "../../src/modules/settings/lists";
import { createSpace } from "../../src/modules/spaces/service";
import { E2E_DATABASE_URL, E2E_P2_PASSWORD, E2E_P2_USERS, E2E_WS_PROXY } from "./env";

/**
 * Phases 9 and 10 journeys (PHASE9_PLAN §4): the reception uploads an ID card it cannot open,
 * the manager opens it by a signed link and removes it; the details and the contract print
 * with the logo and the policy fixed at confirmation (90 days → 75% — the venue changes to
 * "0 days → 100%" afterwards); an expense on the booking shows in it with its net, and is
 * voided from S-11. The booking: evening 60,000, deposit 15,000, 100 days ahead.
 */
test.describe.configure({ mode: "serial" });

const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");
const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

/** A 1 × 1 PNG: the browser decodes it, so the upload's image step runs for real. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type World = { bookingNo: string; category: string };
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
    const deps = { db, hasher, now: new Date(), files: createFileStore(LOCAL_FILE_STORE) };
    const today = cairoDate(deps.now);

    await db
      .update(venues)
      .set({
        phone: "0223456789",
        address: "القاهرة",
        minDepositType: "none",
        minDepositValue: 0,
        cancellationBasis: "deposit",
        postponeCreditMode: "refund",
      })
      .where(eq(venues.id, actor.venueId));
    const setTiers = async (tiers: { minDaysBefore: number; refundBps: number }[]) => {
      await db.delete(cancellationTiers).where(eq(cancellationTiers.venueId, actor.venueId));
      await db.insert(cancellationTiers).values(tiers.map((t) => ({ venueId: actor.venueId, ...t })));
    };
    await setTiers([
      { minDaysBefore: 90, refundBps: 7500 },
      { minDaysBefore: 30, refundBps: 5000 },
      { minDaysBefore: 0, refundBps: 0 },
    ]);
    await setLogo(deps, actor, { file: new Blob([PIXEL], { type: "image/png" }) });
    const category = `نظافة ${s}9`;
    await createListItem(deps, actor, { kind: "expenseCategories", name: category });
    const { id: methodId } = await createListItem(deps, actor, { kind: "paymentMethods", name: `كاش ${s}9` });
    const { id: spaceId } = await createSpace(deps, actor, {
      name: `قاعة المستندات ${s}`,
      capacityMax: 400,
      day: { start: "13:00", end: "18:00" },
      evening: { start: "20:00", end: "01:00" },
    });
    const { id: weddingId } = await createListItem(deps, actor, {
      kind: "eventTypes",
      name: `فرح ${s}9`,
      isWedding: true,
    });
    const { id: packageId } = await createPackage(deps, actor, {
      spaceId,
      name: `الذهبي ${s}9`,
      description: null,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      isActive: true,
      prices: [{ slotKind: "evening", seasonId: null, price: 6_000_000 }],
      items: [],
    });
    const tentative = await createTentative(deps, actor, {
      spaceId,
      slotKind: "evening",
      startTime: null,
      endTime: null,
      eventDate: addDays(today, 100),
      eventTypeId: weddingId,
      groomName: "أحمد",
      brideName: "منى",
      packageId,
      guests: 200,
      notes: null,
      items: [],
      removedServiceIds: [],
      customer: { name: `عميل المستندات ${s}`, phone: `0128890${s === "د" ? "1" : "2"}001`, altPhone: null },
    });
    await confirmBooking(deps, actor, {
      bookingId: tentative.id,
      version: tentative.version,
      expectedTotal: 6_000_000,
      deposit: { amount: 1_500_000, methodId, paidAt: null },
      installments: [],
    });
    // D-68: the venue's policy changes after the confirmation; the contract keeps the booking's.
    await setTiers([{ minDaysBefore: 0, refundBps: 10000 }]);
    return { bookingNo: tentative.bookingNo, category };
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

test("P9-E1: the reception uploads an ID card photo but cannot open it (BR-90)", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  await openBooking(page, world.bookingNo);
  await page.getByTestId("tab-documents").click();
  await page.getByTestId("upload-document").click();
  const dialog = page.getByTestId("upload-document-dialog");
  await dialog.getByTestId("document-file").setInputFiles({ name: "id.png", mimeType: "image/png", buffer: PIXEL });
  await dialog.getByTestId("upload-document-submit").click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId("document-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-kind", "national_id");
  await expect(row.getByTestId("document-hidden")).toBeVisible();
  await expect(row.getByTestId("open-document")).toHaveCount(0);
  await expect(row.getByTestId("remove-document")).toHaveCount(0);
});

test("P9-E2: the manager opens it by a signed link, then removes it with a reason (SEC-30, Q9-03)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.bookingNo);
  await page.getByTestId("tab-documents").click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("open-document").click();
  const popup = await popupPromise;
  await popup.waitForURL(/X-Amz-Signature=/);
  await expect(popup.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await popup.close();

  await page.getByTestId("remove-document").click();
  const dialog = page.getByTestId("remove-document-dialog");
  await dialog.getByTestId("remove-document-reason").fill("بطاقة شخص تاني");
  await dialog.getByTestId("remove-document-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("document-row")).toHaveCount(0);
});

test("P9-E3: the details and the contract print with the logo and the policy fixed at confirmation (D-68, D-70)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.bookingNo);
  await page.getByTestId("print-details").click();
  await expect(page.getByTestId("booking-details-print")).toBeVisible();
  await expect(page.getByTestId("print-paid")).toContainText("١٥٬٠٠٠");
  await expect(page.getByTestId("print-remaining")).toContainText("٤٥٬٠٠٠");
  await expect(page.getByTestId("venue-logo")).toHaveJSProperty("naturalWidth", 1);

  await page.goBack();
  await page.getByTestId("print-contract").click();
  const contract = page.getByTestId("contract-print");
  await expect(contract).toContainText(world.bookingNo);
  await expect(page.getByTestId("contract-total")).toContainText("٦٠٬٠٠٠");
  const policy = page.getByTestId("contract-policy");
  await expect(policy).toContainText("٧٥٪");
  await expect(policy).toContainText("٥٠٪");
  await expect(policy).not.toContainText("١٠٠٪");
  await expect(page.getByTestId("contract-signatures")).toBeVisible();
  await expect(page.getByTestId("venue-logo")).toHaveJSProperty("naturalWidth", 1);
});

test("P10-E1: an expense on the booking shows in it with the booking's net, and is voided from S-11 (D-50, BR-95)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.bookingNo);
  await page.getByTestId("add-expense").click();
  const dialog = page.getByTestId("add-expense-dialog");
  await dialog.getByTestId("expense-category").click();
  await page.getByRole("option", { name: world.category }).click();
  await dialog.getByTestId("expense-amount").fill("1000");
  const description = `فرقة إضافية ${suffix(info)}`;
  await dialog.getByTestId("expense-description").fill(description);
  await dialog.getByTestId("expense-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-expenses-total")).toContainText("١٬٠٠٠");
  await expect(page.getByTestId("booking-net")).toContainText("١٤٬٠٠٠");

  await page.goto("/expenses");
  await expect(page.getByTestId("period-net")).toBeVisible();
  const row = page.getByTestId("expense-row").filter({ hasText: description });
  await expect(row).toContainText(world.bookingNo);
  await row.getByTestId("void-expense").click();
  const voiding = page.getByTestId("void-expense-dialog");
  await voiding.getByTestId("void-expense-reason").fill("اتسجل غلط");
  await voiding.getByTestId("void-expense-submit").click();
  await expect(voiding).toBeHidden();
  await expect(row).toHaveAttribute("data-voided", "true");
  await expect(row).toContainText("اتسجل غلط");
});
