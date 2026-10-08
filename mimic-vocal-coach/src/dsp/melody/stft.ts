// Short-time Fourier transform helpers on the 10 ms analysis grid used by PitchTrack
// (part of the lead-vocal melody extractor, see vocalMelody.ts).
//
// Frame i of a signal sampled at `sr` is centred on sample round(i * 0.01 * sr) (the same layout as
// trackPitch), so every frame-aligned quantity produced here can be indexed like PitchTrack.f0.
// The window is a periodic Hann; the inverse transform is a weighted overlap-add with the exact
// per-sample window-power normalisation, so STFT -> (identity) -> ISTFT reproduces the input.

import { fft, rfft } from '../fft';

export const HOP_SEC = 0.01;

/** Number of 10 ms frames for a signal of `len` samples (same rule as trackPitch). */
export function frameCount(len: number, sr: number): number {
  return len > 0 ? Math.floor((len - 1) / (HOP_SEC * sr)) + 1 : 0;
}

/** Centre sample of frame i. */
export function frameCentre(i: number, sr: number): number {
  return Math.round(i * HOP_SEC * sr);
}

/** Periodic Hann window of length n. */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Windowed real FFT of x around `centre` (zero outside the signal). Writes bins 0..n/2. */
export class FrameFft {
  readonly n: number;
  readonly win: Float64Array;
  private readonly buf: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.win = hannWindow(n);
    this.buf = new Float64Array(n);
  }

  /** Sum of the window (amplitude of a unit sinusoid's peak bin is sumWin/2). */
  get sumWin(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.win[i];
    return s;
  }

  run(x: ArrayLike<number>, centre: number, re: Float64Array, im: Float64Array): void {
    const { n, win, buf } = this;
    const start = centre - (n >> 1);
    const len = x.length;
    if (start >= 0 && start + n <= len) {
      for (let i = 0; i < n; i++) buf[i] = x[start + i] * win[i];
    } else {
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        buf[i] = idx >= 0 && idx < len ? x[idx] * win[i] : 0;
      }
    }
    rfft(buf, n, re, im);
  }
}

/**
 * Inverse of a real FFT (bins 0..n/2 -> n samples) via one n/2-point complex FFT. The imaginary
 * parts of bins 0 and n/2 are ignored (a real signal has none).
 */
const irfftScratch = new Map<number, { zr: Float64Array; zi: Float64Array; cos: Float64Array; sin: Float64Array }>();
export function irfft(re: ArrayLike<number>, im: ArrayLike<number>, n: number, out: Float64Array): void {
  const h = n >> 1;
  let s = irfftScratch.get(n);
  if (!s) {
    const cos = new Float64Array(h + 1);
    const sin = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    s = { zr: new Float64Array(h), zi: new Float64Array(h), cos, sin };
    irfftScratch.set(n, s);
  }
  const { zr, zi, cos, sin } = s;
  // E[k] = (X[k] + conj X[h-k]) / 2 ; O[k] = W^{-k} (X[k] - conj X[h-k]) / 2 with W = e^{-2 pi i / n};
  // Z[k] = E[k] + i O[k]; z = ifft_h(Z) holds the even samples in Re and the odd samples in Im.
  for (let k = 0; k < h; k++) {
    const kr = k;
    const mr = h - k;
    const xr = re[kr];
    const xi = k === 0 ? 0 : im[kr];
    const yr = re[mr];
    const yi = mr === h ? 0 : im[mr];
    const er = 0.5 * (xr + yr);
    const ei = 0.5 * (xi - yi);
    const dr = 0.5 * (xr - yr);
    const di = 0.5 * (xi + yi);
    // O = (dr + i di) * W^{-k} = (dr + i di) * (cos + i sin)
    const or = dr * cos[k] - di * sin[k];
    const oi = dr * sin[k] + di * cos[k];
    zr[k] = er - oi;
    zi[k] = ei + or;
  }
  fft(zr, zi, true);
  for (let m = 0; m < h; m++) {
    out[2 * m] = zr[m];
    out[2 * m + 1] = zi[m];
  }
}

/**
 * Weighted overlap-add accumulator for the inverse STFT. Add frames with add(); finish() divides by
 * the accumulated squared-window weights (analysis and synthesis both use the same Hann window).
 */
export class OverlapAdd {
  readonly out: Float32Array;
  private readonly norm: Float32Array;
  private readonly frame: Float64Array;
  private readonly win: Float64Array;
  private readonly n: number;

  constructor(len: number, n: number) {
    this.out = new Float32Array(len);
    this.norm = new Float32Array(len);
    this.frame = new Float64Array(n);
    this.win = hannWindow(n);
    this.n = n;
  }

  /** Add the frame with spectrum (re, im) (bins 0..n/2) centred on `centre`. */
  add(re: ArrayLike<number>, im: ArrayLike<number>, centre: number): void {
    const { n, frame, win, out, norm } = this;
    irfft(re, im, n, frame);
    const start = centre - (n >> 1);
    const len = out.length;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= len) continue;
      out[idx] += frame[i] * win[i];
      norm[idx] += win[i] * win[i];
    }
  }

  finish(): Float32Array {
    const { out, norm } = this;
    for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
    return out;
  }
}
