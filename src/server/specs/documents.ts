import {
  bookingDocumentsSchema,
  documentIdSchema,
  removeDocumentSchema,
  uploadDocumentSchema,
} from "@/modules/documents/schemas";
import { getDocumentViewUrl, listDocuments, removeDocument, uploadDocument } from "@/modules/documents/service";
import { defineProtected } from "./define";

/**
 * API.md "Documents" (phase 9). Viewing and removing depend on the document's kind (Q9-02,
 * Q9-03), so the service checks the exact permission once it has read the row.
 */
export const documentSpecs = {
  upload: defineProtected({
    schema: uploadDocumentSchema,
    requires: "documents.upload",
    handler: (ctx, input) => uploadDocument(ctx, ctx.actor, input),
  }),
  list: defineProtected({
    schema: bookingDocumentsSchema,
    requires: "bookings.view",
    handler: (ctx, input) => listDocuments(ctx.db, ctx.actor, input.bookingId),
  }),
  getViewUrl: defineProtected({
    schema: documentIdSchema,
    requires: "authenticated",
    handler: (ctx, input) => getDocumentViewUrl(ctx, ctx.actor, input.documentId),
  }),
  remove: defineProtected({
    schema: removeDocumentSchema,
    requires: "authenticated",
    handler: (ctx, input) => removeDocument(ctx, ctx.actor, input),
  }),
};
