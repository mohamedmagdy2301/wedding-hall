import { describe, expect, it } from "vitest";
import { fileProblem, IMAGE_TYPES, MAX_LOGO_BYTES, sniffMime } from "@/domain/files";

const ascii = (text: string) => new TextEncoder().encode(text);
const withHead = (head: number[], size = 32) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};

describe("uploaded file types from their bytes (SEC-23, P9-03)", () => {
  it("knows JPEG, PNG, WEBP and PDF by their signatures", () => {
    expect(sniffMime(withHead([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(sniffMime(withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(ascii("RIFF\x10\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(ascii("%PDF-1.4\n"))).toBe("application/pdf");
  });

  it("refuses anything else, a RIFF that is not WEBP and a cut signature", () => {
    expect(sniffMime(ascii("GIF89a"))).toBeNull();
    expect(sniffMime(ascii("RIFF\x10\x00\x00\x00WAVEfmt "))).toBeNull();
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it("checks emptiness, the size limit (inclusive) and the allowed types", () => {
    const jpeg = (size: number) => withHead([0xff, 0xd8, 0xff], size);
    expect(fileProblem(new Uint8Array(0), 10)).toBe("fileEmpty");
    expect(fileProblem(jpeg(MAX_LOGO_BYTES), MAX_LOGO_BYTES, IMAGE_TYPES)).toBeNull();
    expect(fileProblem(jpeg(MAX_LOGO_BYTES + 1), MAX_LOGO_BYTES, IMAGE_TYPES)).toBe("fileTooLarge");
    expect(fileProblem(ascii("%PDF-1.4"), MAX_LOGO_BYTES, IMAGE_TYPES)).toBe("fileTypeNotAllowed");
    expect(fileProblem(ascii("%PDF-1.4"), MAX_LOGO_BYTES)).toBeNull();
  });
});
