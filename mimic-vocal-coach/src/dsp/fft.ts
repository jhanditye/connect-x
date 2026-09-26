// Radix-2 FFT with per-size cached tables, a real-input FFT built on a half-size complex FFT,
// and the Hann window / power spectrum helpers the analysis code needs.

interface FftTables {
  /** Bit-reversal permutation. */
  rev: Uint32Array;
  /** cos(2*pi*i/n) and sin(2*pi*i/n) for i < n/2. */
  cos: Float64Array;
  sin: Float64Array;
}

const tableCache = new Map<number, FftTables>();

function isPow2(n: number): boolean {
  return n >= 1 && Number.isInteger(n) && (n & (n - 1)) === 0;
}

function tablesFor(n: number): FftTables {
  const cached = tableCache.get(n);
  if (cached) return cached;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const t = { rev, cos, sin };
  tableCache.set(n, t);
  return t;
}

/** Smallest power of two >= n (1 for n <= 1). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * In-place iterative radix-2 complex FFT. re/im length must be a power of two.
 * Forward uses e^{-i 2 pi k n / N}. The inverse includes the 1/N scaling, so
 * fft(re, im) followed by fft(re, im, true) restores the input.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (im.length !== n) throw new Error('fft: re and im must have the same length');
  if (!isPow2(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (n === 1) return;
  const { rev, cos, sin } = tablesFor(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = n / size;
    for (let j = 0; j < halfSize; j++) {
      const wr = cos[j * step];
      const wi = sign * sin[j * step];
      for (let a = j; a < n; a += size) {
        const b = a + halfSize;
        const xr = re[b];
        const xi = im[b];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

interface RfftScratch {
  zr: Float64Array;
  zi: Float64Array;
}
const rfftScratch = new Map<number, RfftScratch>();

/**
 * Forward FFT of a real sequence, zero-padded (or truncated) to `n` samples, computed with one
 * n/2-point complex FFT (even samples in the real part, odd samples in the imaginary part) and a
 * split step. Writes bins 0..n/2 into outRe/outIm, which must hold at least n/2 + 1 values.
 * Scratch buffers are cached per size, so repeated calls do not allocate.
 */
export function rfft(x: ArrayLike<number>, n: number, outRe: Float64Array, outIm: Float64Array): void {
  if (!isPow2(n) || n < 2) throw new Error(`rfft: size ${n} must be a power of two >= 2`);
  const h = n >> 1;
  if (outRe.length < h + 1 || outIm.length < h + 1) throw new Error('rfft: output buffers too short');
  let s = rfftScratch.get(n);
  if (!s) {
    s = { zr: new Float64Array(h), zi: new Float64Array(h) };
    rfftScratch.set(n, s);
  }
  const { zr, zi } = s;
  const len = Math.min(x.length, n);
  for (let i = 0; i < h; i++) {
    const e = 2 * i;
    zr[i] = e < len ? x[e] : 0;
    zi[i] = e + 1 < len ? x[e + 1] : 0;
  }
  fft(zr, zi);
  // Twiddles e^{-i 2 pi k / n} come from the size-n table (cos/sin of 2*pi*k/n for k < n/2).
  const { cos, sin } = tablesFor(n);
  for (let k = 0; k <= h; k++) {
    const k1 = k === h ? 0 : k;
    const k2 = k === 0 ? 0 : h - k;
    const ar = zr[k1];
    const ai = zi[k1];
    const br = zr[k2];
    const bi = zi[k2];
    // Even-sample spectrum E = (Z[k] + conj Z[h-k]) / 2, odd-sample spectrum O = (Z[k] - conj Z[h-k]) / 2i.
    const er = 0.5 * (ar + br);
    const ei = 0.5 * (ai - bi);
    const or = 0.5 * (ai + bi);
    const oi = -0.5 * (ar - br);
    const c = k === h ? -1 : cos[k];
    const sn = k === h ? 0 : sin[k];
    // X[k] = E + W^k O with W = cos - i sin.
    outRe[k] = er + c * or + sn * oi;
    outIm[k] = ei + c * oi - sn * or;
  }
}

/** Periodic ("DFT-even") Hann window: w[i] = 0.5 - 0.5 cos(2 pi i / n). Its peak is at index n/2. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

interface PsScratch {
  re: Float64Array;
  im: Float64Array;
}
const psScratch = new Map<number, PsScratch>();

/**
 * |X(k)|^2 for k = 0..fftSize/2 of a (zero-padded) real frame. Frame is used as given (window it
 * first); samples beyond fftSize are ignored. fftSize must be a power of two.
 */
export function powerSpectrum(frame: ArrayLike<number>, fftSize: number): Float64Array {
  const h = fftSize >> 1;
  let s = psScratch.get(fftSize);
  if (!s) {
    s = { re: new Float64Array(h + 1), im: new Float64Array(h + 1) };
    psScratch.set(fftSize, s);
  }
  rfft(frame, fftSize, s.re, s.im);
  const out = new Float64Array(h + 1);
  for (let k = 0; k <= h; k++) out[k] = s.re[k] * s.re[k] + s.im[k] * s.im[k];
  return out;
}
