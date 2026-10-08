// Storage format helpers. Clip audio is kept as mono Int16 PCM in 10 s chunks (about 5.5 MB per minute at 48 kHz), so
// a phrase window is read from one or two chunks without decoding or loading the rest of the clip.

export const CHUNK_SEC = 10;
export const MAX_STORE_RATE = 48000;
/** Bytes per stored frame. */
export const BYTES_PER_FRAME = 2;

export function floatToInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!(v === v)) continue; // NaN is stored as silence
    const s = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(x: Int16Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] < 0 ? x[i] / 0x8000 : x[i] / 0x7fff;
  return out;
}

/** Bytes a stored clip of `frames` frames takes. */
export function audioBytes(frames: number): number {
  return Math.max(0, Math.floor(frames)) * BYTES_PER_FRAME;
}

/** Frames per chunk for a sample rate; throws on a rate no audio can have. */
export function chunkFramesFor(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError(`Unsupported sample rate: ${sampleRate}`);
  return Math.round(CHUNK_SEC * sampleRate);
}

/** Chunk boundaries as [startFrame, endFrame) pairs. */
export function chunkRanges(frames: number, chunkFrames: number): [number, number][] {
  const out: [number, number][] = [];
  if (!(chunkFrames >= 1)) return out;
  for (let s = 0; s < frames; s += chunkFrames) out.push([s, Math.min(frames, s + chunkFrames)]);
  return out;
}

export interface ChunkRange {
  /** First and last chunk index that hold [from, to); last < first when the range is empty. */
  first: number;
  last: number;
  /** Frame range, clamped to the clip. */
  from: number;
  to: number;
}

/** The chunk indices that cover [fromSec, toSec). A range outside the clip, or an empty one, is empty (last < first). */
export function chunksFor(fromSec: number, toSec: number, sampleRate: number, chunkFrames: number, frames: number): ChunkRange {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) throw new RangeError('The audio range must be finite.');
  const from = Math.max(0, Math.min(frames, Math.floor(fromSec * sampleRate)));
  const to = Math.max(from, Math.min(frames, Math.ceil(toSec * sampleRate)));
  const first = Math.floor(from / chunkFrames);
  if (to <= from) return { first, last: first - 1, from, to };
  return { first, last: Math.floor((to - 1) / chunkFrames), from, to };
}

/** Joins stored chunks (consecutive, starting at chunk `first`) and cuts [from, to) frames out of them. */
export function sliceChunks(chunks: Int16Array[], first: number, chunkFrames: number, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  let w = 0;
  for (let k = 0; k < chunks.length; k++) {
    const base = (first + k) * chunkFrames;
    const a = Math.max(from, base);
    const b = Math.min(to, base + chunks[k].length);
    for (let i = a; i < b; i++) {
      const v = chunks[k][i - base];
      out[w++] = v < 0 ? v / 0x8000 : v / 0x7fff;
    }
  }
  return out;
}

/** Peak envelope for a waveform strip: `bins` values 0..1 (max |x| per bin). */
export function peaks(x: Float32Array, bins: number): Float32Array {
  const n = Math.max(0, Math.floor(bins));
  const out = new Float32Array(n);
  if (x.length === 0) return out;
  const per = x.length / n;
  for (let b = 0; b < n; b++) {
    const a = Math.floor(b * per);
    const end = Math.min(x.length, Math.max(a + 1, Math.floor((b + 1) * per)));
    let m = 0;
    for (let i = a; i < end; i++) {
      const v = Math.abs(x[i]);
      if (v > m) m = v;
    }
    out[b] = m > 1 ? 1 : m;
  }
  return out;
}

/** SHA-1 in plain JS for pages where crypto.subtle is missing (insecure origins, some file:// loads). Inputs here are at most 128 KiB. */
export function sha1Hex(bytes: Uint8Array): string {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) ((f = (b & c) | (~b & d)), (k = 0x5a827999));
      else if (i < 40) ((f = b ^ c ^ d), (k = 0x6ed9eba1));
      else if (i < 60) ((f = (b & c) | (b & d) | (c & d)), (k = 0x8f1bbcdc));
      else ((f = b ^ c ^ d), (k = 0xca62c1d6));
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => v.toString(16).padStart(8, '0')).join('');
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-1', bytes as BufferSource);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Some browsers expose subtle but refuse it on insecure origins; the JS version gives the same digest.
    }
  }
  return sha1Hex(bytes);
}

/** "size:durationMs:sha1(first 64 KiB + last 64 KiB)" - enough to re-link a re-imported file to its clip, without storing the file. */
export async function fingerprint(bytes: Uint8Array, size: number, durationSec: number): Promise<string> {
  const head = bytes.subarray(0, 65536);
  const tail = bytes.subarray(Math.max(0, bytes.length - 65536));
  const both = new Uint8Array(head.length + tail.length);
  both.set(head, 0);
  both.set(tail, head.length);
  const hex = await digestHex(both);
  const ms = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0;
  return `${Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0}:${ms}:${hex.slice(0, 16)}`;
}

/**
 * Parses a fingerprint back into its parts, or null when it is not one. A clip that stores only an excerpt of its file
 * adds "@startMs" (where the excerpt starts in the file); `startMs` is 0 for a clip stored whole.
 */
export function parseFingerprint(fp: string): { size: number; durationMs: number; hash: string; startMs: number } | null {
  const m = /^(\d+):(\d+):([0-9a-f]{16})(?:@(\d+))?$/.exec(fp);
  return m ? { size: Number(m[1]), durationMs: Number(m[2]), hash: m[3], startMs: m[4] ? Number(m[4]) : 0 } : null;
}

/** The part of a fingerprint that identifies the source file (without the excerpt offset). */
export function sourceKey(fp: string): string {
  const at = fp.indexOf('@');
  return at < 0 ? fp : fp.slice(0, at);
}

/** Decoders disagree by a few milliseconds on the length of MP3/M4A files (Chrome vs Safari, an OS update): this much is the same file. */
export const SAME_FILE_DURATION_MS = 300;

/**
 * True when two fingerprints are of the same source file: the same size and content hash, and a decoded length within
 * SAME_FILE_DURATION_MS (an excerpt offset "@startMs" is ignored). Anything that is not a fingerprint compares as plain text.
 */
export function sameSourceFile(a: string, b: string, toleranceMs: number = SAME_FILE_DURATION_MS): boolean {
  const x = parseFingerprint(a);
  const y = parseFingerprint(b);
  if (!x || !y) return a !== '' && b !== '' && sourceKey(a) === sourceKey(b);
  return x.size === y.size && x.hash === y.hash && Math.abs(x.durationMs - y.durationMs) <= toleranceMs;
}
