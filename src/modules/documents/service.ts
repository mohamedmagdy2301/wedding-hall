import { and, asc, eq, isNull } from "drizzle-orm";
import { bookingDocuments, bookings, users } from "@/db/schema";
import {
  DOCUMENT_TYPES,
  fileProblem,
  MAX_DOCUMENT_BYTES,
  sniffMime,
  type DocumentMime,
  type FileProblem,
} from "@/domain/files";
import type { FileStore } from "@/lib/r2";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx } from "@/modules/shared/db";
import { AppError, forbidden, notFound } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import type { DocumentKind, RemoveDocumentInput, UploadDocumentInput } from "./schemas";

/**
 * Booking documents (BR-90, SEC-23, SEC-30, Q9-01..Q9-03). The file goes to R2 under a random
 * key before its row is written; a link to it is signed for a few minutes after the viewer's
 * permission is checked, and every opening is audited.
 */

/** SEC-30: how long a viewing link works. R2 refuses it afterwards. */
export const VIEW_LINK_SECONDS = 300;

export function requireFiles(deps: ServiceDeps): FileStore {
  if (!deps.files) throw new AppError("INTERNAL_ERROR", "storageUnavailable");
  return deps.files;
}

/** Q9-02: an ID card needs `documents.view_id`; the other kinds go with the booking. */
export const canViewKind = (actor: SessionUser, kind: DocumentKind) =>
  satisfies(actor, kind === "national_id" ? "documents.view_id" : "bookings.view");

/** Q9-03: removing an ID card needs `documents.view_id`; the other kinds `documents.upload`. */
export const canRemoveKind = (actor: SessionUser, kind: DocumentKind) =>
  satisfies(actor, kind === "national_id" ? "documents.view_id" : "documents.upload");

export const fileProblemError = (problem: string) =>
  new AppError("VALIDATION_ERROR", problem, { fieldErrors: { file: problem } });

/** Reads the upload and checks it from its bytes (P9-03). `messages` renames a problem (the logo's limits). */
export async function readUpload(
  file: Blob,
  maxBytes: number,
  allowed: readonly DocumentMime[] = DOCUMENT_TYPES,
  messages: Partial<Record<FileProblem, string>> = {},
) {
  const fail = (problem: FileProblem) => fileProblemError(messages[problem] ?? problem);
  // A larger body is refused before it is read whole.
  if (file.size > maxBytes) throw fail("fileTooLarge");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = fileProblem(bytes, maxBytes, allowed);
  if (problem) throw fail(problem);
  return { bytes, mimeType: sniffMime(bytes)! };
}

async function findBooking(db: DbOrTx, venueId: string, bookingId: string) {
  const [booking] = await db
    .select({ id: bookings.id, bookingNo: bookings.bookingNo })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)));
  if (!booking) throw notFound("bookingNotFound");
  return booking;
}

export async function uploadDocument(deps: ServiceDeps, actor: SessionUser, input: UploadDocumentInput) {
  assertAllowed(actor, "documents.upload");
  const files = requireFiles(deps);
  const venueId = actor.venueId;
  const booking = await findBooking(deps.db, venueId, input.bookingId);
  const { bytes, mimeType } = await readUpload(input.file, MAX_DOCUMENT_BYTES);
  // SEC-23: a random name, nothing from the uploaded file's name.
  const fileKey = `venues/${venueId}/documents/${crypto.randomUUID()}`;
  await files.put(fileKey, bytes, mimeType);
  try {
    return await runTransaction(deps.db, async (tx) => {
      const [row] = await tx
        .insert(bookingDocuments)
        .values({
          venueId,
          bookingId: booking.id,
          kind: input.kind,
          fileKey,
          mimeType,
          sizeBytes: bytes.byteLength,
          uploadedBy: actor.userId,
        })
        .returning({ id: bookingDocuments.id });
      await recordAudit(tx, {
        venueId,
        actorId: actor.userId,
        action: "documents.upload",
        entityType: "document",
        entityId: row.id,
        after: { bookingNo: booking.bookingNo, kind: input.kind, mimeType, sizeBytes: bytes.byteLength },
        meta: { bookingId: booking.id },
      });
      return { id: row.id };
    });
  } catch (error) {
    // P9-04: no row, no file. A failed cleanup only leaves an unreferenced object.
    await files.delete(fileKey).catch(() => console.error("orphan document file left in R2"));
    throw error;
  }
}

export type BookingDocument = {
  id: string;
  kind: DocumentKind;
  mimeType: string;
  sizeBytes: number;
  uploadedByName: string;
  createdAt: Date;
  canView: boolean;
  canRemove: boolean;
};

/** S-07 "المستندات" (`bookings.view`): an ID card is listed without its file for the others. */
export async function listDocuments(db: DbOrTx, actor: SessionUser, bookingId: string): Promise<BookingDocument[]> {
  assertAllowed(actor, "bookings.view");
  const rows = await db
    .select({
      id: bookingDocuments.id,
      kind: bookingDocuments.kind,
      mimeType: bookingDocuments.mimeType,
      sizeBytes: bookingDocuments.sizeBytes,
      uploadedByName: users.name,
      createdAt: bookingDocuments.createdAt,
    })
    .from(bookingDocuments)
    .innerJoin(users, eq(users.id, bookingDocuments.uploadedBy))
    .where(
      and(
        eq(bookingDocuments.bookingId, bookingId),
        eq(bookingDocuments.venueId, actor.venueId),
        isNull(bookingDocuments.removedAt),
      ),
    )
    .orderBy(asc(bookingDocuments.createdAt));
  return rows.map((r) => ({ ...r, canView: canViewKind(actor, r.kind), canRemove: canRemoveKind(actor, r.kind) }));
}

async function findDocument(db: DbOrTx, venueId: string, documentId: string, lock = false) {
  const query = db
    .select({
      id: bookingDocuments.id,
      bookingId: bookingDocuments.bookingId,
      bookingNo: bookings.bookingNo,
      kind: bookingDocuments.kind,
      fileKey: bookingDocuments.fileKey,
      removedAt: bookingDocuments.removedAt,
    })
    .from(bookingDocuments)
    .innerJoin(bookings, eq(bookings.id, bookingDocuments.bookingId))
    .where(and(eq(bookingDocuments.id, documentId), eq(bookingDocuments.venueId, venueId)));
  const [doc] = await (lock ? query.for("update", { of: bookingDocuments }) : query);
  if (!doc || doc.removedAt) throw notFound("documentNotFound");
  return doc;
}

/** BR-90, SEC-30: a link signed for `VIEW_LINK_SECONDS`, after the permission check, audited. */
export async function getDocumentViewUrl(deps: ServiceDeps, actor: SessionUser, documentId: string) {
  const files = requireFiles(deps);
  const doc = await findDocument(deps.db, actor.venueId, documentId);
  if (!canViewKind(actor, doc.kind)) throw forbidden("forbidden", "BR-90");
  const url = await files.signedGetUrl(doc.fileKey, VIEW_LINK_SECONDS);
  await runTransaction(deps.db, (tx) =>
    recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "documents.view",
      entityType: "document",
      entityId: doc.id,
      meta: { bookingId: doc.bookingId, bookingNo: doc.bookingNo, kind: doc.kind },
    }),
  );
  return { url, expiresInSeconds: VIEW_LINK_SECONDS };
}

/**
 * Q9-03: the row stays (removed once, with the reason) and the file is deleted from R2. The
 * delete runs last inside the transaction: if it fails nothing is marked and the user retries;
 * if the commit fails after it, a retry finds the file already gone and completes.
 */
export async function removeDocument(deps: ServiceDeps, actor: SessionUser, input: RemoveDocumentInput) {
  const files = requireFiles(deps);
  await runTransaction(deps.db, async (tx) => {
    const doc = await findDocument(tx, actor.venueId, input.documentId, true);
    if (!canRemoveKind(actor, doc.kind)) throw forbidden("forbidden", "BR-90");
    await tx
      .update(bookingDocuments)
      .set({ removedAt: deps.now, removedBy: actor.userId, removeReason: input.reason })
      .where(eq(bookingDocuments.id, doc.id));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "documents.remove",
      entityType: "document",
      entityId: doc.id,
      before: { bookingNo: doc.bookingNo, kind: doc.kind },
      after: { removeReason: input.reason },
      meta: { bookingId: doc.bookingId },
    });
    await files.delete(doc.fileKey);
  });
}
