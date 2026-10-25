import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, bookingDocuments, venues } from "@/db/schema";
import { MAX_DOCUMENT_BYTES, MAX_LOGO_BYTES } from "@/domain/files";
import { VIEW_LINK_SECONDS } from "@/modules/documents/service";
import { runProtected } from "@/server/action-core";
import { documentSpecs } from "@/server/specs/documents";
import { settingsSpecs } from "@/server/specs/settings";
import { bookingScenario, failed, NOW, ok } from "./helpers/booking-scenario";
import { connectTestDb, truncateAll } from "./helpers/db";
import { depsAt, META, testFiles } from "./helpers/fixtures";
import { pgErrorCode } from "./helpers/pg-error";

/**
 * Phase 9 documents and logo (BR-90, SEC-23, SEC-30, Q9-01..Q9-03, P9-03..P9-06) through the
 * action pipeline, with the files in the local R2 stand-in (versitygw).
 */

const bytes = (head: number[], size = 64) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode("%PDF-1.7\n% signed contract\n");
const file = (content: Uint8Array, name: string, type = "") => new File([content], name, { type });

describe("documents (BR-90, SEC-23, SEC-30)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  async function setUp() {
    const s = await bookingScenario(handle);
    const booking = await s.create();
    const upload = (kind: string, f: File, token = s.reception.token) =>
      s.call(documentSpecs.upload, { bookingId: booking.id, kind, file: f }, token);
    return { ...s, booking, upload };
  }

  const fileKeyOf = async (id: string) =>
    (await db.select({ key: bookingDocuments.fileKey }).from(bookingDocuments).where(eq(bookingDocuments.id, id)))[0]
      .key;

  it("BR-90: the reception uploads an ID card but cannot open it; the manager opens it and the opening is audited", async () => {
    const s = await setUp();
    const { id } = ok(await s.upload("national_id", file(JPEG, "id.png", "image/png")));

    const [row] = await db.select().from(bookingDocuments).where(eq(bookingDocuments.id, id));
    // P9-03: the type comes from the bytes, the key is random and has no file name (SEC-23).
    expect(row).toMatchObject({ kind: "national_id", mimeType: "image/jpeg", sizeBytes: 64 });
    expect(row.fileKey).toMatch(new RegExp(`^venues/${s.venueId}/documents/[0-9a-f-]{36}$`));

    const listed = ok(await s.call(documentSpecs.list, { bookingId: s.booking.id }));
    expect(listed).toMatchObject([{ id, kind: "national_id", canView: false, canRemove: false }]);
    expect(failed(await s.call(documentSpecs.getViewUrl, { documentId: id })).code).toBe("FORBIDDEN");

    const view = ok(await s.call(documentSpecs.getViewUrl, { documentId: id }, s.manager.token));
    expect(view.expiresInSeconds).toBe(VIEW_LINK_SECONDS);
    expect(new URL(view.url).searchParams.get("X-Amz-Expires")).toBe("300");
    const response = await fetch(view.url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG);

    const opened = await db
      .select({ actorId: auditLogs.actorId, meta: auditLogs.meta })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "documents.view"), eq(auditLogs.entityId, id)));
    expect(opened).toEqual([
      {
        actorId: s.manager.actor.userId,
        meta: { bookingId: s.booking.id, bookingNo: s.booking.bookingNo, kind: "national_id" },
      },
    ]);
  });

  it("Q9-02: a signed contract (PDF) opens for anyone with bookings.view, and that opening is audited too", async () => {
    const s = await setUp();
    const { id } = ok(await s.upload("signed_contract", file(PDF, "contract.pdf")));
    const listed = ok(await s.call(documentSpecs.list, { bookingId: s.booking.id }, s.accountant.token));
    expect(listed).toMatchObject([{ kind: "signed_contract", mimeType: "application/pdf", canView: true }]);
    const view = ok(await s.call(documentSpecs.getViewUrl, { documentId: id }));
    expect((await fetch(view.url)).status).toBe(200);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "documents.view"), eq(auditLogs.actorId, s.reception.actor.userId)));
    expect(count).toBe(1);
  });

  it("SEC-23: a renamed text file, an empty file and 5 MB + 1 byte are refused; uploading needs documents.upload", async () => {
    const s = await setUp();
    const fake = failed(
      await s.upload("national_id", file(new TextEncoder().encode("not a picture"), "id.jpg", "image/jpeg")),
    );
    expect(fake).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fake.fieldErrors?.file).toBeTruthy();
    expect(failed(await s.upload("other", file(new Uint8Array(0), "empty.jpg"))).code).toBe("VALIDATION_ERROR");
    const big = failed(await s.upload("other", file(bytes([0xff, 0xd8, 0xff], MAX_DOCUMENT_BYTES + 1), "big.jpg")));
    expect(big.fieldErrors?.file).toBe("الملف أكبر من 5 ميجا.");
    // Exactly 5 MB is allowed.
    ok(await s.upload("other", file(bytes([0xff, 0xd8, 0xff], MAX_DOCUMENT_BYTES), "max.jpg")));

    expect(failed(await s.upload("other", file(JPEG, "a.jpg"), s.accountant.token)).code).toBe("FORBIDDEN");
    expect(failed(await s.upload("passport", file(JPEG, "a.jpg"))).code).toBe("VALIDATION_ERROR");
    expect(await db.select({ id: bookingDocuments.id }).from(bookingDocuments)).toHaveLength(1);
  });

  it("SEC-30: R2 refuses the file without a signature, with a tampered one and after the link's time", async () => {
    const s = await setUp();
    const { id } = ok(await s.upload("national_id", file(PNG, "id.png")));
    const key = await fileKeyOf(id);
    const signed = new URL(await testFiles.signedGetUrl(key, 1));
    const unsigned = `${signed.origin}${signed.pathname}`;
    expect((await fetch(unsigned)).status).toBe(403);
    const tampered = new URL(signed);
    tampered.searchParams.set("X-Amz-Expires", "3600");
    expect((await fetch(tampered)).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect((await fetch(signed)).status).toBe(403);
  });

  it("Q9-03: removing keeps the row with the reason and deletes the file; an ID card needs documents.view_id", async () => {
    const s = await setUp();
    const { id } = ok(await s.upload("national_id", file(JPEG, "wrong-person.jpg")));
    const key = await fileKeyOf(id);

    const tooShort = failed(await s.call(documentSpecs.remove, { documentId: id, reason: "x" }, s.manager.token));
    expect(tooShort.code).toBe("VALIDATION_ERROR");
    expect(failed(await s.call(documentSpecs.remove, { documentId: id, reason: "بطاقة شخص تاني" })).code).toBe(
      "FORBIDDEN",
    );
    ok(await s.call(documentSpecs.remove, { documentId: id, reason: "بطاقة شخص تاني" }, s.manager.token));

    const [row] = await db.select().from(bookingDocuments).where(eq(bookingDocuments.id, id));
    expect(row).toMatchObject({ removedBy: s.manager.actor.userId, removeReason: "بطاقة شخص تاني" });
    expect((await fetch(await testFiles.signedGetUrl(key, 60))).status).toBe(404);
    expect(ok(await s.call(documentSpecs.list, { bookingId: s.booking.id }))).toEqual([]);
    expect(failed(await s.call(documentSpecs.getViewUrl, { documentId: id }, s.manager.token)).code).toBe("NOT_FOUND");
    expect(
      failed(await s.call(documentSpecs.remove, { documentId: id, reason: "مرة تانية" }, s.manager.token)).code,
    ).toBe("NOT_FOUND");

    // Any other kind is removed with documents.upload (the reception).
    const other = ok(await s.upload("other", file(PDF, "x.pdf")));
    ok(await s.call(documentSpecs.remove, { documentId: other.id, reason: "اترفع غلط" }));

    const actions = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityType, "document"));
    expect(actions.map((a) => a.action)).toEqual([
      "documents.upload",
      "documents.remove",
      "documents.upload",
      "documents.remove",
    ]);
  });

  it("P9-05: the database refuses deleting a document and any change but one removal", async () => {
    const s = await setUp();
    const { id } = ok(await s.upload("other", file(JPEG, "a.jpg")));
    const refused = async (work: Promise<unknown>) =>
      expect(
        pgErrorCode(
          await work.then(
            () => null,
            (e) => e,
          ),
        ),
      ).toBe("42501");
    await refused(db.delete(bookingDocuments).where(eq(bookingDocuments.id, id)));
    await refused(db.update(bookingDocuments).set({ kind: "national_id" }).where(eq(bookingDocuments.id, id)));
    ok(await s.call(documentSpecs.remove, { documentId: id, reason: "اترفع غلط" }));
    await refused(db.update(bookingDocuments).set({ removeReason: "سبب تاني" }).where(eq(bookingDocuments.id, id)));
  });

  it("without R2 configured, uploading says storage is not ready and writes nothing", async () => {
    const s = await setUp();
    const result = await runProtected(
      { ...depsAt(handle, NOW), files: null, sessionToken: s.reception.token, requestMeta: META },
      documentSpecs.upload,
      documentSpecs.upload.handler,
      { bookingId: s.booking.id, kind: "other", file: file(JPEG, "a.jpg") },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: expect.stringContaining("تخزين") },
    });
    expect(await db.select({ id: bookingDocuments.id }).from(bookingDocuments)).toHaveLength(0);
  });
});

describe("venue logo (D-70, P9-06)", () => {
  const handle = connectTestDb();
  const db = handle.db;
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const logoKey = async () => (await db.select({ key: venues.logoKey }).from(venues))[0].key;

  it("the owner sets, replaces and removes the logo; the old file is deleted each time", async () => {
    const s = await bookingScenario(handle);
    ok(await s.call(settingsSpecs.setLogo, { file: file(PNG, "logo.png") }, s.owner.token));
    const first = await logoKey();
    expect(first).toMatch(new RegExp(`^venues/${s.venueId}/logo/`));

    ok(await s.call(settingsSpecs.setLogo, { file: file(JPEG, "logo.jpg") }, s.owner.token));
    const second = await logoKey();
    expect(second).not.toBe(first);
    expect((await fetch(await testFiles.signedGetUrl(first!, 60))).status).toBe(404);
    expect((await fetch(await testFiles.signedGetUrl(second!, 60))).status).toBe(200);

    ok(await s.call(settingsSpecs.removeLogo, {}, s.owner.token));
    expect(await logoKey()).toBeNull();
    expect((await fetch(await testFiles.signedGetUrl(second!, 60))).status).toBe(404);

    const actions = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(sql`${auditLogs.action} LIKE 'settings.logo%'`);
    expect(actions.map((a) => a.action)).toEqual([
      "settings.logo_updated",
      "settings.logo_updated",
      "settings.logo_removed",
    ]);
  });

  it("a PDF, 1 MB + 1 byte and the reception are refused", async () => {
    const s = await bookingScenario(handle);
    const pdf = failed(await s.call(settingsSpecs.setLogo, { file: file(PDF, "logo.pdf") }, s.owner.token));
    expect(pdf.fieldErrors?.file).toBe("الشعار لازم يكون صورة (JPEG أو PNG أو WEBP).");
    const big = failed(
      await s.call(
        settingsSpecs.setLogo,
        { file: file(bytes([0xff, 0xd8, 0xff], MAX_LOGO_BYTES + 1), "l.jpg") },
        s.owner.token,
      ),
    );
    expect(big.fieldErrors?.file).toBe("الشعار أكبر من 1 ميجا.");
    expect(failed(await s.call(settingsSpecs.setLogo, { file: file(PNG, "l.png") })).code).toBe("FORBIDDEN");
    expect(await logoKey()).toBeNull();
  });
});
