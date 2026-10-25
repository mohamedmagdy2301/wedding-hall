/**
 * P9-03: a photo from a phone camera is shrunk in the browser before upload — longest side
 * 2000 px, JPEG — with the canvas only (no library). PDFs and small images go as they are;
 * the server checks every file from its bytes anyway.
 */

const MAX_SIDE = 2000;
const SMALL_ENOUGH = 1024 * 1024;

export async function prepareImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_ENOUGH) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    // A white page under transparent pixels, which JPEG cannot keep.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? blob : file;
  } finally {
    bitmap.close();
  }
}
