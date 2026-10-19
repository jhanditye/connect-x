// Frame-level analysis shared by the Skills scorers: pitch track in MIDI, take status, smoothing, voiced stretches and
// the held-pitch estimate over whole vibrato cycles. Pure; no DOM, no audio.

import { hzToMidi } from '../../dsp/music';
import { trackPitch } from '../../dsp/pitch';
import { median, movingAverage, percentile } from '../../dsp/stats';
import type { Finding, TakeStatus } from '../types';
import {
  PURE_TONE_HARMONIC_RATIO,
  PURE_TONE_REFUSAL,
  PURE_TONE_ROUGHNESS_CENTS,
  SHORT_NOTE_MAX_SEC,
  SHORT_NOTE_MIN_SEC,
  GAP_BRIDGE_SEC,
  GAP_MAYBE_SEC,
  LEVEL_DIP_DB,
  MIN_VOICED_SEC,
  NO_PITCH_LOUD_DB,
  OCTAVE_MATCH_CENTS,
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

/** A note's held pitch with what the vibrato fit found (internal; `heldPitch` returns only the pitch). */
export interface HeldFit {
  /** Fractional MIDI; NaN when there were no voiced frames. */
  midi: number;
  /** Vibrato semi-extent in semitones (0 when the median was used). */
  amp: number;
  /** Vibrato rate used, Hz; null when the median was used. */
  rateHz: number | null;
  /** Whether the vibrato-centre fit was used (otherwise the median). */
  fitted: boolean;
  /** Half the 10-90 percentile range of the frames, semitones (how far the raw pitch swung). */
  spread: number;
  /** Seconds covered by the frames (first to last, plus one hop). */
  spanSec: number;
}

const VIB_MIN_HZ = 3.5;
const VIB_MAX_HZ = 8.5;
const VIB_STEP_HZ = 0.1;

function collect(values: ArrayLike<number>, frames: ArrayLike<number> | undefined, hop: number): { v: number[]; t: number[] } {
  const v: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    v.push(values[i]);
    t.push((frames ? frames[i] : i) * hop);
  }
  return { v, t };
}

/**
 * Held pitch (fractional MIDI) of a note's steady frames, as the centre of its vibrato: the model
 * pitch = c + a * sin(wt) + b * cos(wt)  (+ d * (t - tMid) when the frames span two or more vibrato cycles) is fitted
 * by least squares, either at a given vibrato rate (`rateHz`, from the whole take: see `jointVibratoRate`) or at the
 * best rate from 3.5 to 8.5 Hz. c is then the centre over the whole note, unbiased by a partial cycle at either end (a
 * plain median or mean over 1.5 cycles can be 10-40 cents off with a wide vibrato). The slope term is left out on
 * short notes because over one or two cycles it trades off against the vibrato phase and drags c. With no clear
 * vibrato (amplitude under 8 cents, or the fit explains under 30 % of the variance) the median is used. `frames` are
 * the frame indices of `values`.
 */
export function heldPitch(values: ArrayLike<number>, frames?: ArrayLike<number>, hop = 0.01, rateHz?: number | null): number {
  return heldPitchFit(values, frames, hop, rateHz).midi;
}

/** `heldPitch` with the details of the fit (see HeldFit). */
export function heldPitchFit(values: ArrayLike<number>, frames?: ArrayLike<number>, hop = 0.01, rateHz?: number | null): HeldFit {
  const { v, t } = collect(values, frames, hop);
  if (v.length === 0) return { midi: NaN, amp: 0, rateHz: null, fitted: false, spread: 0, spanSec: 0 };
  const med = median(v);
  const sorted = [...v].sort((x, y) => x - y);
  const spread = 0.5 * (sorted[Math.floor(0.9 * (sorted.length - 1))] - sorted[Math.floor(0.1 * (sorted.length - 1))]);
  const spanSec = t[t.length - 1] - t[0] + hop;
  const plain: HeldFit = { midi: med, amp: 0, rateHz: null, fitted: false, spread, spanSec };
  if (v.length < 12) return plain;
  // Outliers (tracker blips) out before fitting.
  const xs: number[] = [];
  const ts: number[] = [];
  for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - med) <= 1.5) {
    xs.push(v[i]);
    ts.push(t[i]);
  }
  const n = xs.length;
  if (n < 12) return plain;
  const ssTot = sumSqDev(xs);
  if (ssTot <= 1e-12) return plain;
  const rates = rateHz ? [rateHz] : rateGrid();
  let best: { c: number; amp: number; ss: number; hz: number } | null = null;
  for (const hz of rates) {
    const fit = fitVibrato(xs, ts, hz, spanSec * hz >= 2);
    if (fit && (!best || fit.ss < best.ss)) best = { ...fit, hz };
  }
  // The centre may sit up to one vibrato extent from the median of a partial cycle, never further.
  if (!best || best.amp < 0.08 || best.ss > 0.7 * ssTot || Math.abs(best.c - med) > 0.3 + best.amp) return { ...plain, amp: best?.amp ?? 0 };
  return { midi: best.c, amp: best.amp, rateHz: best.hz, fitted: true, spread, spanSec };
}

function rateGrid(): number[] {
  const out: number[] = [];
  for (let hz = VIB_MIN_HZ; hz <= VIB_MAX_HZ + 1e-9; hz += VIB_STEP_HZ) out.push(Math.round(hz * 100) / 100);
  return out;
}

function sumSqDev(xs: readonly number[]): number {
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s;
}

/**
 * The singer's vibrato rate over a whole take: one rate shared by every note (each with its own centre, slope and
 * phase), the rate whose fit leaves the least residual summed over the notes. A 0.5 s line note holds only two or
 * three cycles, too few to find the rate on its own, but six such notes together pin it down. Null when there is no
 * clear vibrato (the shared fit explains under 40 % of the variance, or the mean extent is under 8 cents).
 */
export function jointVibratoRate(notes: readonly { values: ArrayLike<number>; frames: ArrayLike<number> }[], hop: number): number | null {
  const sets: { xs: number[]; ts: number[]; span: number; ssTot: number }[] = [];
  for (const nt of notes) {
    const { v, t } = collect(nt.values, nt.frames, hop);
    if (v.length < 12) continue;
    const med = median(v);
    const xs: number[] = [];
    const ts: number[] = [];
    for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - med) <= 1.5) {
      xs.push(v[i]);
      ts.push(t[i]);
    }
    if (xs.length < 12) continue;
    sets.push({ xs, ts, span: ts[ts.length - 1] - ts[0] + hop, ssTot: sumSqDev(xs) });
  }
  if (!sets.length) return null;
  const ssTot = sets.reduce((s, x) => s + x.ssTot, 0);
  if (ssTot <= 1e-12) return null;
  let best: { hz: number; ss: number; amp: number } | null = null;
  for (const hz of rateGrid()) {
    let ss = 0;
    let ampW = 0;
    let w = 0;
    for (const st of sets) {
      const fit = fitVibrato(st.xs, st.ts, hz, st.span * hz >= 2);
      if (!fit) {
        ss += st.ssTot;
        continue;
      }
      ss += fit.ss;
      ampW += fit.amp * st.xs.length;
      w += st.xs.length;
    }
    if (!best || ss < best.ss) best = { hz, ss, amp: w ? ampW / w : 0 };
  }
  if (!best || best.ss > 0.6 * ssTot || best.amp < 0.08) return null;
  return best.hz;
}

/** Least squares for x = c + a sin(wt) + b cos(wt) (+ d (t - tMid) when `withSlope`); null when singular. */
function fitVibrato(xs: readonly number[], ts: readonly number[], hz: number, withSlope: boolean): { c: number; amp: number; ss: number } | null {
  const w = 2 * Math.PI * hz;
  const p = withSlope ? 4 : 3;
  const tMid = 0.5 * (ts[0] + ts[ts.length - 1]);
  const m = new Float64Array(p * p);
  const r = new Float64Array(p);
  const row = new Float64Array(p);
  const fill = (t: number) => {
    row[0] = 1;
    row[1] = Math.sin(w * t);
    row[2] = Math.cos(w * t);
    if (withSlope) row[3] = t - tMid;
  };
  for (let i = 0; i < xs.length; i++) {
    fill(ts[i]);
    for (let a = 0; a < p; a++) {
      r[a] += row[a] * xs[i];
      for (let b = 0; b < p; b++) m[a * p + b] += row[a] * row[b];
    }
  }
  const sol = solveN(m, r, p);
  if (!sol) return null;
  let ss = 0;
  for (let i = 0; i < xs.length; i++) {
    fill(ts[i]);
    let f = 0;
    for (let a = 0; a < p; a++) f += sol[a] * row[a];
    ss += (xs[i] - f) ** 2;
  }
  return { c: sol[0], amp: Math.hypot(sol[1], sol[2]), ss };
}

/**
 * Size of a pitch step at frame `cut` between the frames [a, cut) and [cut, b), with the vibrato (at `rateHz`) fitted
 * across both sides at once: x = c + s * [t >= tCut] + a sin(wt) + b cos(wt). Returns s in semitones, or null when a
 * side has too few frames. A swing of a wide vibrato read as a "step" by two window means comes out near 0 here.
 */
export function vibratoStep(midi: Float64Array, a: number, cut: number, b: number, hop: number, rateHz: number): number | null {
  const w = 2 * Math.PI * rateHz;
  const m = new Float64Array(16);
  const r = new Float64Array(4);
  const row = new Float64Array(4);
  let nl = 0;
  let nr = 0;
  for (let k = a; k < b; k++) {
    const x = midi[k];
    if (Number.isNaN(x)) continue;
    const t = k * hop;
    row[0] = 1;
    row[1] = k >= cut ? 1 : 0;
    row[2] = Math.sin(w * t);
    row[3] = Math.cos(w * t);
    if (k >= cut) nr++;
    else nl++;
    for (let p = 0; p < 4; p++) {
      r[p] += row[p] * x;
      for (let q = 0; q < 4; q++) m[p * 4 + q] += row[p] * row[q];
    }
  }
  if (nl < 5 || nr < 5) return null;
  const sol = solveN(m, r, 4);
  return sol ? sol[1] : null;
}

/** Gaussian elimination with partial pivoting on an n x n system (copies its inputs). */
function solveN(m0: Float64Array, r0: Float64Array, n: number): number[] | null {
  const m = Float64Array.from(m0);
  const r = Float64Array.from(r0);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(m[i * n + c]) > Math.abs(m[p * n + c])) p = i;
    if (Math.abs(m[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let j = 0; j < n; j++) [m[c * n + j], m[p * n + j]] = [m[p * n + j], m[c * n + j]];
      [r[c], r[p]] = [r[p], r[c]];
    }
    for (let i = c + 1; i < n; i++) {
      const f = m[i * n + c] / m[c * n + c];
      for (let j = c; j < n; j++) m[i * n + j] -= f * m[c * n + j];
      r[i] -= f * r[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i];
    for (let j = i + 1; j < n; j++) s -= m[i * n + j] * x[j];
    x[i] = s / m[i * n + i];
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

/**
 * Splits a pitch difference (cents) into whole octaves plus a remainder. Only a remainder within OCTAVE_MATCH_CENTS
 * counts as "the same note in another octave"; anything else is a different note, returned unfolded with octaves 0
 * (a 5th up is +700, never "an octave up and 500 flat").
 */
export function octaveAndCents(diffCents: number): { octaves: number; cents: number } {
  const k = Math.round(diffCents / 1200);
  const rest = diffCents - 1200 * k;
  if (k !== 0 && Math.abs(rest) <= OCTAVE_MATCH_CENTS) return { octaves: k, cents: rest };
  return { octaves: 0, cents: diffCents };
}

/** What the voice check measured on a note (see `voiceCheck`). */
export interface VoiceCheck {
  /** Median over the checked frames of (energy in harmonics 2..10 above the noise between them) / (energy in harmonic 1). A pure tone is ~0. */
  harmonicRatio: number;
  /** Median over the checked frames of the number of harmonics (2..10) standing 13 dB or more above the noise between them. */
  harmonicsAboveNoise: number;
  /** SD of the frame-to-frame pitch change after removing the slow movement, cents (jitter-like roughness). */
  roughnessCents: number;
  /** Frames checked. */
  frames: number;
}

/** A harmonic "stands out" when its power is this many times the noise between harmonics (13 dB). */
const HARMONIC_ABOVE_NOISE = 20;

/** Power of x[a .. a + n) (Hann window) at `hz` (Goertzel, any frequency). */
function tonePower(x: Float32Array, a: number, n: number, hz: number, sampleRate: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const cw = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const v = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    const s0 = v + cw * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - cw * s1 * s2;
}

/**
 * A cheap check that a note looks like a voice rather than a pure electronic tone (the prompt leaking from a speaker,
 * a tuning app, a sine drone). Measured on up to `maxFrames` voiced frames of [i0, i1): the harmonic ratio (a voice,
 * breathy or falsetto, always has some energy at 2f0, 3f0...) and the pitch roughness (a voice always jitters a
 * little; an oscillator does not).
 */
export function voiceCheck(samples: Float32Array, sampleRate: number, fr: TakeFrames, i0: number, i1: number, maxFrames = 12): VoiceCheck {
  const idx: number[] = [];
  for (let k = i0; k < i1; k++) if (!Number.isNaN(fr.midi[k])) idx.push(k);
  const ratios: number[] = [];
  const counts: number[] = [];
  const step = Math.max(1, Math.floor(idx.length / maxFrames));
  for (let j = Math.floor(step / 2); j < idx.length && ratios.length < maxFrames; j += step) {
    const k = idx[j];
    // fr.midi is at the singer's A4, which this function does not know: start from A4 = 440 and search +/-60 cents.
    const f0 = 440 * Math.pow(2, (fr.midi[k] - 69) / 12);
    const n = Math.min(Math.round(Math.max(0.06, 8 / f0) * sampleRate), samples.length);
    const a = Math.max(0, Math.min(samples.length - n, Math.round(k * fr.hop * sampleRate) - (n >> 1)));
    // Find the fundamental within +/-60 cents (covers any A4 setting from about 425 to 455 Hz).
    let best = 0;
    let bestHz = f0;
    for (let c = -60; c <= 60; c += 10) {
      const hz = f0 * Math.pow(2, c / 1200);
      const p = tonePower(samples, a, n, hz, sampleRate);
      if (p > best) {
        best = p;
        bestHz = hz;
      }
    }
    if (best <= 0) continue;
    // Energy at the harmonics above what the noise puts between them (room noise and breath noise are not harmonics).
    let harm = 0;
    let count = 0;
    for (let h = 2; h <= 10 && h * bestHz < 0.45 * sampleRate; h++) {
      const floor = 0.5 * (tonePower(samples, a, n, (h - 0.5) * bestHz, sampleRate) + tonePower(samples, a, n, (h + 0.5) * bestHz, sampleRate));
      const p = tonePower(samples, a, n, h * bestHz, sampleRate);
      harm += Math.max(0, p - floor);
      if (p > HARMONIC_ABOVE_NOISE * floor) count++;
    }
    ratios.push(harm / best);
    counts.push(count);
  }
  // Roughness: second difference of the pitch track (removes vibrato and glides, keeps frame-to-frame jitter).
  const d2: number[] = [];
  for (let k = i0 + 1; k + 1 < i1; k++) {
    const x0 = fr.midi[k - 1];
    const x1 = fr.midi[k];
    const x2 = fr.midi[k + 1];
    if (Number.isNaN(x0) || Number.isNaN(x1) || Number.isNaN(x2)) continue;
    const v = (x2 - 2 * x1 + x0) * 100;
    if (Math.abs(v) < 50) d2.push(v);
  }
  let rough = 0;
  if (d2.length) {
    let m = 0;
    for (const v of d2) m += v;
    m /= d2.length;
    for (const v of d2) rough += (v - m) ** 2;
    rough = Math.sqrt(rough / d2.length);
  }
  return {
    harmonicRatio: ratios.length ? median(ratios) : NaN,
    harmonicsAboveNoise: counts.length ? median(counts) : 0,
    roughnessCents: rough,
    frames: ratios.length,
  };
}

/**
 * A steady pure tone, not a voice: almost no harmonics (under PURE_TONE_HARMONIC_RATIO of the fundamental's energy,
 * at most one harmonic above the noise) and a pitch steadier than any voice (roughness under PURE_TONE_ROUGHNESS_CENTS;
 * every synthetic voice tested, breathy, soft or falsetto, read 3 cents or more, an oscillator 0.1 to 1.6).
 */
export function isPureTone(vc: VoiceCheck): boolean {
  if (!PURE_TONE_REFUSAL) return false;
  return vc.frames >= 3 && vc.harmonicRatio < PURE_TONE_HARMONIC_RATIO && vc.harmonicsAboveNoise <= 1 && vc.roughnessCents < PURE_TONE_ROUGHNESS_CENTS;
}

/** The finding for a take refused by the voice check. */
export function pureToneFinding(): Finding {
  return {
    tone: 'info',
    text: 'That sounded like a pure electronic tone (a speaker, a tuning app or a drone), not a voice, so it is not scored. Sing it yourself; if the prompt can reach the microphone, use headphones.',
  };
}

/**
 * When a take has a sung note that was simply too short to measure (a stretch of voicing with one steady pitch, but
 * shorter than MIN_VOICED_SEC or than the scorer needs), its length in seconds; otherwise null.
 */
export function shortNoteSec(fr: TakeFrames): number | null {
  let best: [number, number] | null = null;
  for (const st of voicedStretches(fr, 0.1)) if (!best || st[1] - st[0] > best[1] - best[0]) best = st;
  if (!best) return null;
  const vals: number[] = [];
  const lv: number[] = [];
  for (let k = best[0]; k < best[1]; k++) if (!Number.isNaN(fr.midi[k])) {
    vals.push(fr.midi[k]);
    lv.push(fr.rmsDb[k]);
  }
  const sec = vals.length * fr.hop;
  // A note voiced for SHORT_NOTE_MAX_SEC or longer was not refused for being short: name the real reason instead.
  if (sec < SHORT_NOTE_MIN_SEC || sec >= SHORT_NOTE_MAX_SEC || percentile(lv, 90) < QUIET_P90_DB) return null;
  const sorted = [...vals].sort((x, y) => x - y);
  const spread = sorted[Math.floor(0.9 * (sorted.length - 1))] - sorted[Math.floor(0.1 * (sorted.length - 1))];
  return spread <= 1 ? sec : null;
}

/** The finding for a take that could not be scored, naming a too-short note when that is the reason. */
export function unscoredFindingFor(fr: TakeFrames, status: TakeStatus): Finding {
  const short = shortNoteSec(fr);
  if (short !== null) {
    return {
      tone: 'info',
      text: `I heard a note, but only for about ${short.toFixed(1)} seconds: too short to measure, so it is not scored. Hold it for about a second.`,
    };
  }
  return unscoredFinding(status);
}
