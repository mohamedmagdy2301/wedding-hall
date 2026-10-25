import { z } from "zod";
import { id } from "@/modules/shared/fields";

// API.md "Documents" (phase 9, Q9-02, Q9-03). The file arrives as a Blob from the Server
// Action; its size and real type are checked by the service from its bytes (P9-03).

export const DOCUMENT_KINDS = ["national_id", "signed_contract", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const fileField = z.instanceof(Blob, { message: "fileRequired" });

export const uploadDocumentSchema = z.object({
  bookingId: id,
  kind: z.enum(DOCUMENT_KINDS, "documentKindInvalid"),
  file: fileField,
});
export type UploadDocumentInput = z.output<typeof uploadDocumentSchema>;

export const documentIdSchema = z.object({ documentId: id });

export const removeDocumentSchema = z.object({
  documentId: id,
  reason: z.string().trim().min(3, "removeReasonInvalid").max(300, "removeReasonInvalid"),
});
export type RemoveDocumentInput = z.output<typeof removeDocumentSchema>;

export const bookingDocumentsSchema = z.object({ bookingId: id });

export const setLogoSchema = z.object({ file: fileField });
