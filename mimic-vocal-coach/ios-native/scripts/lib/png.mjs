// Reads just enough of a PNG to check an app icon: size, colour type and whether it carries transparency.
// (Apple rejects an App Store icon with an alpha channel, and iOS paints transparency black on the Home Screen.)
import fs from 'node:fs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPES = { 0: 'grayscale', 2: 'RGB', 3: 'palette', 4: 'grayscale+alpha', 6: 'RGBA' };

export function pngInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is not a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  // Walk the chunks looking for tRNS (transparency for palette / grey / RGB images).
  let hasTrns = false;
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'tRNS') hasTrns = true;
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const hasAlpha = colorType === 4 || colorType === 6 || hasTrns;
  return { width, height, bitDepth, colorType, colorName: COLOR_TYPES[colorType] ?? `type ${colorType}`, interlace, hasAlpha, bytes: buf.length };
}
