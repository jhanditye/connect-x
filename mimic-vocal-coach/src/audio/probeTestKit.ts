// Synthetic container headers for the probe and decode tests. Test support only: nothing in the app imports this file.

export const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** A FLAC header: STREAMINFO with the given rate and total samples (44.1 kHz stereo 16-bit unless stated). */
export function flacHeader(rate: number, totalSamples: number, channels = 2, bits = 16) {
  const b = new Uint8Array(42);
  b.set(ascii('fLaC'), 0);
  b[4] = 0; // STREAMINFO, not the last block
  b[7] = 34;
  b[18] = (rate >> 12) & 0xff;
  b[19] = (rate >> 4) & 0xff;
  b[20] = ((rate & 0xf) << 4) | (((channels - 1) & 7) << 1) | (((bits - 1) >> 4) & 1);
  b[21] = (((bits - 1) & 0xf) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0xf);
  new DataView(b.buffer).setUint32(22, totalSamples >>> 0);
  return b;
}

/** An MP3 frame header (MPEG1 layer III, 128 kbps, 44.1 kHz, stereo) with an optional Xing frame count, padded to `size` bytes. */
export function mp3Bytes(opts: { size?: number; xingFrames?: number; vbriFrames?: number; id3?: number } = {}) {
  const id3 = opts.id3 ?? 0;
  const out = new Uint8Array(id3 + (opts.size ?? 4096));
  if (id3 > 0) {
    out.set(ascii('ID3'), 0);
    out[3] = 3;
    const body = id3 - 10;
    out[6] = (body >> 21) & 0x7f;
    out[7] = (body >> 14) & 0x7f;
    out[8] = (body >> 7) & 0x7f;
    out[9] = body & 0x7f;
  }
  out.set([0xff, 0xfb, 0x90, 0x00], id3);
  const dv = new DataView(out.buffer);
  if (opts.xingFrames !== undefined) {
    out.set(ascii('Xing'), id3 + 36);
    dv.setUint32(id3 + 40, 1); // flags: frame count present
    dv.setUint32(id3 + 44, opts.xingFrames);
  }
  if (opts.vbriFrames !== undefined) {
    out.set(ascii('VBRI'), id3 + 36);
    dv.setUint32(id3 + 50, opts.vbriFrames);
  }
  return out;
}

export function oggPage(granule: number, payload: number[], type = 0) {
  const out = new Uint8Array(27 + 1 + payload.length);
  out.set(ascii('OggS'), 0);
  out[5] = type;
  const dv = new DataView(out.buffer);
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  out[26] = 1;
  out[27] = payload.length;
  out.set(payload, 28);
  return out;
}

export function oggVorbis(rate: number, seconds: number) {
  const ident = [1, ...ascii('vorbis'), 0, 0, 0, 0, 2, rate & 0xff, (rate >> 8) & 0xff, (rate >> 16) & 0xff, (rate >> 24) & 0xff, 0, 0, 0, 0];
  const first = oggPage(0, ident, 2);
  const middle = new Uint8Array(5000);
  const last = oggPage(Math.round(rate * seconds), [1, 2, 3], 4);
  const out = new Uint8Array(first.length + middle.length + last.length);
  out.set(first, 0);
  out.set(middle, first.length);
  out.set(last, first.length + middle.length);
  return out;
}

