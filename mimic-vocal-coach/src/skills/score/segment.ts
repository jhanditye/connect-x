// Notes in a sung take: building one SungNote from a frame range (held pitch over whole vibrato cycles, landing,
// stability) and segmenting a line into notes (pitch steps, unvoiced gaps, level dips; glides belong to no note).

import { mean, median } from '../../dsp/stats';
import type { SungNote } from '../types';
import {
  GLIDE_SLOPE_ST_PER_SEC,
  LANDING_SLOPE_ST_PER_SEC,
  LANDING_WINDOW_SEC,
  LEVEL_DIP_DB,
  NOTE_MIN_SEC,
  SMOOTH_SEC,
  SPLIT_CENTS,
  SPLIT_MIN_SIDE_SEC,
  SPLIT_WINDOW_SEC,
  STEADY_BAND_CENTS,
  STEADY_SKIP_END_SEC,
  STEADY_SKIP_END_SHARE,
  STEADY_SKIP_START_SEC,
  STEADY_SKIP_START_SHARE,
} from './constants';
import { analyseTake, heldPitch, sdCents, slopeAt, smoothRange, voicedStretches, type TakeFrames } from './frames';

/** A note plus the frame range it came from (internal). */
export interface NoteSpan {
  i0: number;
  i1: number;
  note: SungNote;
}

const smoothFrames = (hop: number) => Math.max(3, Math.round(SMOOTH_SEC / hop) | 1);

/**
 * Builds a note from frames [i0, i1). Glide frames at either end (smoothed pitch more than STEADY_BAND_CENTS from the
 * median, or moving faster than GLIDE_SLOPE_ST_PER_SEC) are trimmed off; returns null when what is left is shorter
 * than `minSec`.
 */
export function buildNote(fr: TakeFrames, i0: number, i1: number, minSec = NOTE_MIN_SEC): NoteSpan | null {
  const hop = fr.hop;
  const win = smoothFrames(hop);
  let sm = smoothRange(fr.midi, i0, i1, win);
  const med0 = median(fr.midi.subarray(i0, i1));
  if (Number.isNaN(med0)) return null;
  const band = STEADY_BAND_CENTS / 100;
  const ok = (k: number) => {
    if (Number.isNaN(sm[k]) || Math.abs(sm[k] - med0) > band) return false;
    const sl = slopeAt(sm, k, hop);
    return Number.isNaN(sl) || Math.abs(sl) <= GLIDE_SLOPE_ST_PER_SEC;
  };
  let a = 0;
  let b = i1 - i0;
  while (a < b && !ok(a)) a++;
  while (b > a && !ok(b - 1)) b--;
  if ((b - a) * hop < minSec) return null;
  const c0 = i0 + a;
  const c1 = i0 + b;
  // Re-smooth over the trimmed note so the glide no longer leaks into its edges.
  sm = smoothRange(fr.midi, c0, c1, win);
  const med = median(fr.midi.subarray(c0, c1));
  const len = c1 - c0;
  const skipA = Math.min(Math.round(STEADY_SKIP_START_SEC / hop), Math.floor(len * STEADY_SKIP_START_SHARE));
  const skipB = Math.min(Math.round(STEADY_SKIP_END_SEC / hop), Math.floor(len * STEADY_SKIP_END_SHARE));
  const raw: number[] = [];
  const idx: number[] = [];
  const smooth: number[] = [];
  for (let k = skipA; k < len - skipB; k++) {
    const r = fr.midi[c0 + k];
    if (Number.isNaN(r) || Number.isNaN(sm[k]) || Math.abs(sm[k] - med) > band) continue;
    raw.push(r);
    idx.push(c0 + k);
    smooth.push(sm[k]);
  }
  if (raw.length < 5) {
    raw.length = 0;
    idx.length = 0;
    smooth.length = 0;
    for (let k = 0; k < len; k++) {
      if (Number.isNaN(fr.midi[c0 + k])) continue;
      raw.push(fr.midi[c0 + k]);
      idx.push(c0 + k);
      smooth.push(sm[k]);
    }
  }
  const held = heldPitch(raw, idx, hop);
  // Landing: the first LANDING_WINDOW_SEC after the smoothed slope first drops under LANDING_SLOPE_ST_PER_SEC.
  let landingMidi: number | null = null;
  const lw = Math.round(LANDING_WINDOW_SEC / hop);
  for (let k = 0; k + lw <= len; k++) {
    const sl = slopeAt(sm, k, hop);
    if (Number.isNaN(sl) || Math.abs(sl) >= LANDING_SLOPE_ST_PER_SEC) continue;
    const m = landingPitch(fr, c0 + k, lw);
    if (!Number.isNaN(m)) landingMidi = m;
    break;
  }
  const levels: number[] = [];
  for (let k = c0; k < c1; k++) if (fr.voiced[k]) levels.push(fr.rmsDb[k]);
  return {
    i0: c0,
    i1: c1,
    note: {
      startSec: c0 * hop,
      endSec: c1 * hop,
      midi: held,
      landingMidi,
      stabilityCents: sdCents(smooth),
      steadySec: raw.length * hop,
      meanRmsDb: levels.length ? mean(levels) : -120,
    },
  };
}

/** Landing pitch: the plain mean of the window [i, i + len) (fractional MIDI, NaN when unvoiced). */
export function landingPitch(fr: TakeFrames, i: number, len: number): number {
  return mean(fr.midi.subarray(i, Math.min(fr.n, i + len)));
}

/** Change points inside a voiced stretch: peaks of |mean(after) - mean(before)| over SPLIT_WINDOW_SEC. */
function pitchBoundaries(fr: TakeFrames, s0: number, s1: number): number[] {
  const hop = fr.hop;
  const w = Math.round(SPLIT_WINDOW_SEC / hop);
  const minSide = Math.round(SPLIT_MIN_SIDE_SEC / hop);
  const len = s1 - s0;
  const sum = new Float64Array(len + 1);
  const cnt = new Float64Array(len + 1);
  for (let k = 0; k < len; k++) {
    const v = fr.midi[s0 + k];
    const okv = !Number.isNaN(v);
    sum[k + 1] = sum[k] + (okv ? v : 0);
    cnt[k + 1] = cnt[k] + (okv ? 1 : 0);
  }
  const d = new Float64Array(len);
  for (let k = 1; k < len; k++) {
    const la = Math.max(0, k - w);
    const rb = Math.min(len, k + w);
    const nl = cnt[k] - cnt[la];
    const nr = cnt[rb] - cnt[k];
    if (nl < minSide || nr < minSide) continue;
    d[k] = (sum[rb] - sum[k]) / nr - (sum[k] - sum[la]) / nl;
  }
  const out: number[] = [];
  const reach = Math.round(NOTE_MIN_SEC / hop) - 2;
  const thr = SPLIT_CENTS / 100;
  for (let k = 1; k < len; k++) {
    const a = Math.abs(d[k]);
    if (a < thr) continue;
    let peak = true;
    for (let j = Math.max(1, k - reach); j <= Math.min(len - 1, k + reach); j++) {
      const b = Math.abs(d[j]);
      if (b > a || (b === a && j < k)) {
        peak = false;
        break;
      }
    }
    if (peak) out.push(s0 + k);
  }
  return out;
}

/** Level dips of LEVEL_DIP_DB below both sides (repeated notes sung legato), as frame indices. */
function dipBoundaries(fr: TakeFrames, s0: number, s1: number): number[] {
  const hop = fr.hop;
  const lv = new Float64Array(s1 - s0);
  for (let k = s0; k < s1; k++) lv[k - s0] = fr.rmsDb[k];
  const sm = smoothRangeDb(lv, Math.max(3, Math.round(0.05 / hop) | 1));
  const edge = Math.round(NOTE_MIN_SEC / hop);
  const reach = Math.round(0.3 / hop);
  const local = Math.round(0.05 / hop);
  const out: number[] = [];
  for (let k = edge; k < sm.length - edge; k++) {
    let isMin = true;
    for (let j = Math.max(0, k - local); j <= Math.min(sm.length - 1, k + local); j++) {
      if (sm[j] < sm[k] || (sm[j] === sm[k] && j < k)) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;
    let left = -Infinity;
    let right = -Infinity;
    for (let j = Math.max(0, k - reach); j < k; j++) left = Math.max(left, sm[j]);
    for (let j = k + 1; j <= Math.min(sm.length - 1, k + reach); j++) right = Math.max(right, sm[j]);
    if (left - sm[k] >= LEVEL_DIP_DB && right - sm[k] >= LEVEL_DIP_DB) out.push(s0 + k);
  }
  return out;
}

function smoothRangeDb(x: Float64Array, window: number): Float64Array {
  const half = window >> 1;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j++) {
      s += x[j];
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

/** Notes of a take as frame spans (internal; the scorers need the frame ranges). */
export function segmentSpans(fr: TakeFrames): NoteSpan[] {
  const spans: NoteSpan[] = [];
  for (const [s0, s1] of voicedStretches(fr)) {
    const cuts = [...new Set([...pitchBoundaries(fr, s0, s1), ...dipBoundaries(fr, s0, s1)])].sort((x, y) => x - y);
    let a = s0;
    for (const c of [...cuts, s1]) {
      if (c - a >= 2) {
        const sp = buildNote(fr, a, c);
        if (sp) spans.push(sp);
      }
      a = c;
    }
  }
  return spans;
}

/**
 * Sung notes in a take, in time order. A note is at least NOTE_MIN_SEC of steady pitch; glides between notes, breath
 * noise and silences are not notes. Returns [] for a take with no voiced sound.
 */
export function segmentNotes(samples: Float32Array, sampleRate: number, a4Hz: number): SungNote[] {
  return segmentSpans(analyseTake(samples, sampleRate, a4Hz)).map((s) => s.note);
}
