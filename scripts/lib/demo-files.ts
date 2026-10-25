import { crc32, deflateSync } from "node:zlib";

/**
 * Small real files for the demo seed (P9-11): a PNG drawn pixel by pixel and a one-page PDF,
 * so the printouts and the documents tab show something that opens. No image library.
 */

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of `width` × `height` whose pixels come from `paint(x, y)`. */
export function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) rows.set(paint(x, y), offset + 1 + x * 3);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(bytes);
}

/** A gold ring on white: the demo venue's logo. */
export const demoLogo = () =>
  png(160, 160, (x, y) => {
    const d = Math.hypot(x - 80, y - 80);
    return d > 50 && d < 70 ? [191, 144, 60] : [255, 255, 255];
  });

/** A grey card with a darker photo box: a stand-in for an ID card photo. */
export const demoIdCard = () =>
  png(320, 200, (x, y) => (x > 20 && x < 110 && y > 40 && y < 160 ? [120, 120, 130] : [214, 218, 224]));

/** A minimal one-page PDF with a line of text (Latin; the demo content only). */
export function demoPdf(text: string) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
