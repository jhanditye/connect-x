// Frame-level analysis shared by the Skills scorers: pitch track in MIDI, take status, smoothing, voiced stretches and
// the held-pitch estimate over whole vibrato cycles. Pure; no DOM, no audio.

import { hzToMidi } from '../../dsp/music';
import { trackPitch } from '../../dsp/pitch';
import { median, movingAverage, percentile } from '../../dsp/stats';
import type { Finding, TakeStatus } from '../types';
import {
  GAP_BRIDGE_SEC,
  GAP_MAYBE_SEC,
  LEVEL_DIP_DB,
  MIN_VOICED_SEC,
  NO_PITCH_LOUD_DB,
  QUIET_P90_DB,
} from './constants';

export interface TakeFrames {
  hop: number;
  n: number;
  /** Fractional MIDI at the singer's A4; NaN where unvoiced. */
  midi: Float64Array;
  rmsDb: Float64Array;
  periodicity: Float64Array;
  voiced: Uint8Array;
  voicedSec: number;
  /** 90th percentile of the voiced frames' level (dBFS); -120 when nothing was voiced. */
  voicedP90Db: number;
  /** 90th percentile of every frame's level (dBFS). */
  allP90Db: number;
}

export function analyseTake(samples: Float32Array, sampleRate: number, a4Hz: number): TakeFrames {
  const tr = trackPitch(samples, sampleRate);
  const n = tr.f0.length;
  const midi = new Float64Array(n);
  let voicedCount = 0;
  const voicedLevels: number[] = [];
  for (let i = 0; i < n; i++) {
    if (tr.voiced[i] && tr.f0[i] > 0) {
      midi[i] = hzToMidi(tr.f0[i], a4Hz);
      voicedCount++;
      voicedLevels.push(tr.rmsDb[i]);
    } else {
      midi[i] = NaN;
    }
  }
  const voicedP90Db = voicedLevels.length ? percentile(voicedLevels, 90) : -120;
  const allP90Db = n ? percentile(tr.rmsDb, 90) : -120;
  return {
    hop: tr.hopSec,
    n,
    midi,
    rmsDb: tr.rmsDb,
    periodicity: tr.periodicity,
    voiced: tr.voiced,
    voicedSec: voicedCount * tr.hopSec,
    voicedP90Db,
    allP90Db,
  };
}

/** 'ok', or why the take cannot be scored (see constants: MIN_VOICED_SEC, QUIET_P90_DB, NO_PITCH_LOUD_DB). */
export function takeStatus(fr: TakeFrames): TakeStatus {
  if (fr.voicedSec >= MIN_VOICED_SEC && fr.voicedP90Db >= QUIET_P90_DB) return 'ok';
  if (fr.voicedSec < MIN_VOICED_SEC && fr.allP90Db >= NO_PITCH_LOUD_DB) return 'no-pitch';
  return 'too-quiet';
}

/** The finding that goes with a take that could not be scored. */
export function unscoredFinding(status: TakeStatus): Finding {
  return status === 'no-pitch'
    ? { tone: 'info', text: 'I heard sound but no steady sung note, so this one is not scored. Try an open "ah" on one pitch.' }
    : { tone: 'info', text: 'That take was too quiet to score. Sing a little louder or move closer to the microphone.' };
}

/** Folds cents into [-600, 600]: octave errors are judged on pitch class. */
export function foldCents(c: number): number {
  return c - 1200 * Math.round(c / 1200);
}

/**
 * Centred moving average of `midi[i0..i1)` over `window` frames, truncated at the range ends and skipping NaN
 * (unvoiced frames stay NaN). Nothing outside the range leaks in, so neighbouring notes do not smear into a note.
 */
export function smoothRange(midi: Float64Array, i0: number, i1: number, window: number): Float64Array {
  return movingAverage(midi.subarray(i0, i1), window);
}

/** Slope of a smoothed contour at k in semitones per second (central difference over +/-2 frames, NaN aware). */
export function slopeAt(sm: Float64Array, k: number, hop: number): number {
  for (const d of [2, 1]) {
    const a = k - d;
    const b = k + d;
    if (a >= 0 && b < sm.length && !Number.isNaN(sm[a]) && !Number.isNaN(sm[b])) return (sm[b] - sm[a]) / (2 * d * hop);
  }
  if (k + 1 < sm.length && !Number.isNaN(sm[k]) && !Number.isNaN(sm[k + 1])) return (sm[k + 1] - sm[k]) / hop;
  if (k >= 1 && !Number.isNaN(sm[k]) && !Number.isNaN(sm[k - 1])) return (sm[k] - sm[k - 1]) / hop;
  return NaN;
}

function levelAround(fr: TakeFrames, from: number, to: number): number {
  const vals: number[] = [];
  for (let i = Math.max(0, from); i < Math.min(fr.n, to); i++) if (fr.voiced[i]) vals.push(fr.rmsDb[i]);
  return vals.length ? median(vals) : -120;
}

/**
 * Voiced stretches [i0, i1): runs of voiced frames with short unvoiced gaps bridged. Gaps under GAP_BRIDGE_SEC are
 * always bridged; gaps up to GAP_MAYBE_SEC only when the level does not dip by LEVEL_DIP_DB (a tracker dropout inside
 * a vowel, not a re-articulated note); longer gaps split. `bridgeSec` > 0 overrides this with a plain bridge.
 */
export function voicedStretches(fr: TakeFrames, bridgeSec = 0): [number, number][] {
  const out: [number, number][] = [];
  const always = Math.round((bridgeSec > 0 ? bridgeSec : GAP_BRIDGE_SEC) / fr.hop);
  const maybe = bridgeSec > 0 ? always : Math.round(GAP_MAYBE_SEC / fr.hop);
  const side = Math.round(0.1 / fr.hop);
  let i = 0;
  while (i < fr.n && !fr.voiced[i]) i++;
  if (i >= fr.n) return out;
  let start = i;
  let end = i;
  while (i < fr.n) {
    if (fr.voiced[i]) {
      end = i + 1;
      i++;
      continue;
    }
    let j = i;
    while (j < fr.n && !fr.voiced[j]) j++;
    if (j >= fr.n) break;
    const gap = j - i;
    let bridge = gap < always;
    if (!bridge && gap < maybe) {
      let gapMin = Infinity;
      for (let k = i; k < j; k++) gapMin = Math.min(gapMin, fr.rmsDb[k]);
      const sides = Math.min(levelAround(fr, i - side, i), levelAround(fr, j, j + side));
      bridge = gapMin > sides - LEVEL_DIP_DB;
    }
    if (!bridge) {
      out.push([start, end]);
      start = j;
    }
    end = j;
    i = j;
  }
  out.push([start, end]);
  return out;
}

/**
 * Held pitch (fractional MIDI) of a note's steady frames. Vibrato is handled by fitting, for each vibrato rate from
 * 3.5 to 8.5 Hz, the model  pitch = c + d * (t - tMid) + a * sin(wt) + b * cos(wt)  by least squares and keeping the
 * best fit: c is then the centre of the vibrato over the whole note, unbiased by a partial cycle at either end (a
 * plain median or mean over 1.5 cycles can be 10-15 cents off). With no clear vibrato (amplitude under 8 cents, or
 * the fit explains under 30 % of the variance) the median is used. `frames` are the frame indices of `values`.
 */
export function heldPitch(values: ArrayLike<number>, frames?: ArrayLike<number>, hop = 0.01): number {
  const v: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    v.push(values[i]);
    t.push((frames ? frames[i] : i) * hop);
  }
  if (v.length === 0) return NaN;
  const med = median(v);
  if (v.length < 15) return med;
  // Outliers (tracker blips) out before fitting.
  const xs: number[] = [];
  const ts: number[] = [];
  for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - med) <= 1.5) {
    xs.push(v[i]);
    ts.push(t[i]);
  }
  const n = xs.length;
  if (n < 15) return med;
  const tMid = 0.5 * (ts[0] + ts[n - 1]);
  let mx = 0;
  for (const x of xs) mx += x;
  mx /= n;
  let ssTot = 0;
  for (const x of xs) ssTot += (x - mx) ** 2;
  if (ssTot <= 1e-12) return med;
  let best: { c: number; amp: number; ss: number } | null = null;
  for (let hz = 3.5; hz <= 8.5 + 1e-9; hz += 0.25) {
    const w = 2 * Math.PI * hz;
    const fit = leastSquares4(xs, ts, tMid, w);
    if (fit && (!best || fit.ss < best.ss)) best = fit;
  }
  if (!best || best.amp < 0.08 || best.ss > 0.7 * ssTot || Math.abs(best.c - med) > 0.3) return med;
  return best.c;
}

/** Least squares for x = c + d (t - tMid) + a sin(wt) + b cos(wt); null when singular. */
function leastSquares4(xs: number[], ts: number[], tMid: number, w: number): { c: number; amp: number; ss: number } | null {
  const m = new Float64Array(16);
  const r = new Float64Array(4);
  const row = new Float64Array(4);
  for (let i = 0; i < xs.length; i++) {
    row[0] = 1;
    row[1] = ts[i] - tMid;
    row[2] = Math.sin(w * ts[i]);
    row[3] = Math.cos(w * ts[i]);
    for (let p = 0; p < 4; p++) {
      r[p] += row[p] * xs[i];
      for (let q = 0; q < 4; q++) m[p * 4 + q] += row[p] * row[q];
    }
  }
  const sol = solve4(m, r);
  if (!sol) return null;
  let ss = 0;
  for (let i = 0; i < xs.length; i++) {
    const f = sol[0] + sol[1] * (ts[i] - tMid) + sol[2] * Math.sin(w * ts[i]) + sol[3] * Math.cos(w * ts[i]);
    ss += (xs[i] - f) ** 2;
  }
  return { c: sol[0], amp: Math.hypot(sol[2], sol[3]), ss };
}

/** Gaussian elimination with partial pivoting on a 4x4 system (copies its inputs). */
function solve4(m0: Float64Array, r0: Float64Array): number[] | null {
  const m = Float64Array.from(m0);
  const r = Float64Array.from(r0);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let i = c + 1; i < 4; i++) if (Math.abs(m[i * 4 + c]) > Math.abs(m[p * 4 + c])) p = i;
    if (Math.abs(m[p * 4 + c]) < 1e-12) return null;
    if (p !== c) {
      for (let j = 0; j < 4; j++) [m[c * 4 + j], m[p * 4 + j]] = [m[p * 4 + j], m[c * 4 + j]];
      [r[c], r[p]] = [r[p], r[c]];
    }
    for (let i = c + 1; i < 4; i++) {
      const f = m[i * 4 + c] / m[c * 4 + c];
      for (let j = c; j < 4; j++) m[i * 4 + j] -= f * m[c * 4 + j];
      r[i] -= f * r[c];
    }
  }
  const x = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) {
    let s = r[i];
    for (let j = i + 1; j < 4; j++) s -= m[i * 4 + j] * x[j];
    x[i] = s / m[i * 4 + i];
  }
  return x;
}

/** Population SD in cents of a contour given in semitones (NaN skipped); NaN when empty. */
export function sdCents(values: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) {
    s += values[i];
    n++;
  }
  if (!n) return NaN;
  const m = s / n;
  let ss = 0;
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) ss += (values[i] - m) ** 2;
  return Math.sqrt(ss / n) * 100;
}
