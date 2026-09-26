// Vibrato detection on one note's pitch contour.
//
// Method: the contour (cents around the note's pitch) is modelled as a quadratic trend plus one
// sinusoid, fitted by least squares for every candidate rate in 3.5-8.5 Hz (a trend-aware
// periodogram; it works on the irregular sampling left by unvoiced frames). The best rate wins;
// the sinusoid's amplitude is the semi-extent. It counts as vibrato when the sinusoid explains at
// least half of the detrended variance (periodic enough) and the semi-extent is 15-200 cents.
// Long notes are analysed in ~1 s chunks, because real vibrato drifts in rate and a single
// sinusoid would not fit a long note well.

import { median } from '../dsp/stats';
import type { FrameFeatures } from '../types';

export const VIBRATO_MIN_NOTE_SEC = 0.45;
const RATE_MIN_HZ = 3.5;
const RATE_MAX_HZ = 8.5;
const RATE_STEP_HZ = 0.05;
const MIN_EXPLAINED = 0.5;
const MIN_EXTENT_CENTS = 15;
const MAX_EXTENT_CENTS = 200;
/**
 * Onset scoops and releases are not vibrato. Singers also tend to start vibrato a little into a
 * held note, so the start trim grows with the note (15 % of it, 50-250 ms); a stretch of straight
 * tone inside the fit would otherwise pull the extent down.
 */
const TRIM_END_SEC = 0.05;
const TRIM_START_REL = 0.15;
const TRIM_START_MIN_SEC = 0.05;
const TRIM_START_MAX_SEC = 0.25;
const MIN_ANALYSIS_SEC = 0.3;
const CHUNK_SEC = 1.0;

export interface VibratoFit {
  rateHz: number;
  extentCents: number;
  /** Share of the detrended variance explained by the sinusoid. */
  explained: number;
}

/** Solves the symmetric positive system A x = b in place (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Residual sum of squares of a least-squares fit of y on the given basis columns. */
function fitRss(basis: Float64Array[], y: Float64Array): { rss: number; coef: number[] } | null {
  const k = basis.length;
  const n = y.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += basis[i][t] * basis[j][t];
      ata[i][j] = s;
      ata[j][i] = s;
    }
    let s = 0;
    for (let t = 0; t < n; t++) s += basis[i][t] * y[t];
    aty[i] = s;
  }
  const coef = solve(ata, aty);
  if (!coef) return null;
  let rss = 0;
  for (let t = 0; t < n; t++) {
    let pred = 0;
    for (let i = 0; i < k; i++) pred += coef[i] * basis[i][t];
    rss += (y[t] - pred) ** 2;
  }
  return { rss, coef };
}

/** Best trend-plus-sinusoid fit of cents(t); null when there are too few points. */
export function fitVibrato(times: ArrayLike<number>, cents: ArrayLike<number>): VibratoFit | null {
  const n = times.length;
  if (n < 12) return null;
  const t0 = times[0];
  const span = times[n - 1] - t0 || 1;
  const y = Float64Array.from(cents);
  const one = new Float64Array(n).fill(1);
  const lin = new Float64Array(n);
  const quad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = (times[i] - t0) / span - 0.5; // centred and scaled for a well-conditioned system
    lin[i] = u;
    quad[i] = u * u;
  }
  const trend = fitRss([one, lin, quad], y);
  if (!trend || !(trend.rss > 0)) return null;

  const sin = new Float64Array(n);
  const cos = new Float64Array(n);
  const rssAt = (rate: number): { rss: number; amp: number } | null => {
    for (let i = 0; i < n; i++) {
      const ph = 2 * Math.PI * rate * (times[i] - t0);
      sin[i] = Math.sin(ph);
      cos[i] = Math.cos(ph);
    }
    const fit = fitRss([one, lin, quad, sin, cos], y);
    return fit ? { rss: fit.rss, amp: Math.hypot(fit.coef[3], fit.coef[4]) } : null;
  };

  const rates: number[] = [];
  const rss: number[] = [];
  for (let r = RATE_MIN_HZ; r <= RATE_MAX_HZ + 1e-9; r += RATE_STEP_HZ) {
    const f = rssAt(r);
    rates.push(r);
    rss.push(f ? f.rss : Infinity);
  }
  let best = 0;
  for (let i = 1; i < rss.length; i++) if (rss[i] < rss[best]) best = i;
  if (!Number.isFinite(rss[best])) return null;
  // Parabolic refinement of the rate between grid points.
  let rate = rates[best];
  if (best > 0 && best < rss.length - 1) {
    const a = rss[best - 1];
    const b = rss[best];
    const c = rss[best + 1];
    const den = a - 2 * b + c;
    if (den > 0) rate += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) * RATE_STEP_HZ;
  }
  const refined = rssAt(rate);
  if (!refined) return null;
  return { rateHz: rate, extentCents: refined.amp, explained: 1 - refined.rss / trend.rss };
}

export function isVibrato(fit: VibratoFit | null): boolean {
  return (
    fit !== null &&
    fit.explained >= MIN_EXPLAINED &&
    fit.extentCents >= MIN_EXTENT_CENTS &&
    fit.extentCents <= MAX_EXTENT_CENTS
  );
}

/**
 * Vibrato of the note spanning frames [i0, i1) with pitch `noteMidi`, or null (note shorter than
 * 0.45 s, or no vibrato). Long notes are split into ~1 s chunks; the note has vibrato when chunks
 * covering at least half its analysed length do, and reports their median rate and extent.
 */
export function detectVibrato(
  frames: FrameFeatures[],
  i0: number,
  i1: number,
  noteMidi: number,
  hopSec: number,
): { rateHz: number; extentCents: number } | null {
  const dur = (i1 - i0) * hopSec;
  if (dur < VIBRATO_MIN_NOTE_SEC - 1e-9) return null;
  const startTrim = Math.min(TRIM_START_MAX_SEC, Math.max(TRIM_START_MIN_SEC, TRIM_START_REL * dur));
  const a = i0 + Math.round(startTrim / hopSec);
  const b = i1 - Math.round(TRIM_END_SEC / hopSec);
  if ((b - a) * hopSec < MIN_ANALYSIS_SEC) return null;
  const chunks = Math.max(1, Math.round(((b - a) * hopSec) / CHUNK_SEC));
  const size = (b - a) / chunks;
  const found: VibratoFit[] = [];
  let vibFrames = 0;
  let allFrames = 0;
  for (let c = 0; c < chunks; c++) {
    const ca = Math.round(a + c * size);
    const cb = Math.round(a + (c + 1) * size);
    const times: number[] = [];
    const cents: number[] = [];
    for (let i = ca; i < cb; i++) {
      if (!frames[i].voiced) continue;
      times.push(frames[i].t);
      cents.push((frames[i].midi - noteMidi) * 100);
    }
    allFrames += cb - ca;
    const fit = fitVibrato(times, cents);
    if (isVibrato(fit) && fit) {
      found.push(fit);
      vibFrames += cb - ca;
    }
  }
  if (found.length === 0 || vibFrames < 0.5 * allFrames) return null;
  return {
    rateHz: median(found.map((f) => f.rateHz)),
    extentCents: median(found.map((f) => f.extentCents)),
  };
}
