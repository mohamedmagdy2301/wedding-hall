/**
 * Uploaded files (SEC-23, P9-03): the type is read from the file's first bytes, never from its
 * name or the browser's claim, so a renamed text file is not stored as a picture.
 */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_LOGO_BYTES = 1024 * 1024;

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DOCUMENT_TYPES = [...IMAGE_TYPES, "application/pdf"] as const;

export type DocumentMime = (typeof DOCUMENT_TYPES)[number];

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The file's real type, or `null` when it is none of the allowed ones. */
export function sniffMime(bytes: Uint8Array): DocumentMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  return null;
}

export type FileProblem = "fileEmpty" | "fileTooLarge" | "fileTypeNotAllowed";

/** Why a file may not be stored, or `null`. `allowed` narrows the types (a logo is an image). */
export function fileProblem(
  bytes: Uint8Array,
  maxBytes: number,
  allowed: readonly DocumentMime[] = DOCUMENT_TYPES,
): FileProblem | null {
  if (bytes.byteLength === 0) return "fileEmpty";
  if (bytes.byteLength > maxBytes) return "fileTooLarge";
  const mime = sniffMime(bytes);
  if (!mime || !allowed.includes(mime)) return "fileTypeNotAllowed";
  return null;
}
