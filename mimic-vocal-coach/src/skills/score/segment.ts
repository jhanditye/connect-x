// Notes in a sung take: building one SungNote from a frame range (held pitch over whole vibrato cycles, landing,
// stability) and segmenting a line into notes (pitch steps, unvoiced gaps, level dips; glides belong to no note).

import { mean, median } from '../../dsp/stats';
import type { SungNote } from '../types';
import {
  CENTRE_CHECK_CENTS,
  CENTRE_CHECK_SHARE,
  CONFIDENT_STEADY_SEC,
  GLIDE_SLOPE_ST_PER_SEC,
  RAMP_MAX_SEC,
  RAMP_MIN_R2,
  RAMP_MIN_ST,
  RAMP_REACH_ST,
  RAMP_VIB_FACTOR,
  UNFITTED_SPREAD_ST,
  VIB_CONFIDENCE_AMP,
  VIB_STEP_WINDOW_SEC,
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
import { analyseTake, heldPitchFit, jointVibratoRate, sdCents, slopeAt, smoothRange, vibratoStep, voicedStretches, type TakeFrames } from './frames';

/** A note plus the frame range it came from (internal). */
export interface NoteSpan {
  i0: number;
  i1: number;
  note: SungNote;
  /** Frame indices of the steady part (the frames the held pitch was measured on). */
  steady: number[];
  /** Vibrato semi-extent found on this note, semitones (0 when none). */
  vibAmp: number;
  /** Vibrato rate used for this note's centre, Hz (null when none). */
  vibRateHz: number | null;
}

/**
 * How far a note's held pitch can be trusted. Low when the steady part is shorter than CONFIDENT_STEADY_SEC, when a
 * clear vibrato (VIB_CONFIDENCE_AMP or wider) was caught over less than one whole cycle, or when the pitch swung
 * widely and no vibrato centre could be fitted (the median of a partial swing is a guess). buildNote also requires the
 * centre to be stable (centreAgrees).
 */
export function noteConfidence(steadySec: number, fit: { amp: number; rateHz: number | null; fitted: boolean; spread: number }): 'high' | 'low' {
  if (steadySec < CONFIDENT_STEADY_SEC) return 'low';
  if (fit.fitted && fit.amp >= VIB_CONFIDENCE_AMP && fit.rateHz !== null && steadySec * fit.rateHz < 1) return 'low';
  if (!fit.fitted && fit.spread >= UNFITTED_SPREAD_ST) return 'low';
  return 'high';
}

const smoothFrames = (hop: number) => Math.max(3, Math.round(SMOOTH_SEC / hop) | 1);

/**
 * Builds a note from frames [i0, i1). Glide frames at either end (smoothed pitch more than STEADY_BAND_CENTS from the
 * median, or moving faster than GLIDE_SLOPE_ST_PER_SEC) are trimmed off; returns null when what is left is shorter
 * than `minSec`. `rateHz` is the take's vibrato rate when known (see jointVibratoRate): a short note's centre is then
 * fitted at that rate instead of searching for one in two or three cycles.
 */
export function buildNote(fr: TakeFrames, i0: number, i1: number, minSec = NOTE_MIN_SEC, rateHz: number | null = null): NoteSpan | null {
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
  const fit = heldPitchFit(raw, idx, hop, rateHz);
  const held = fit.midi;
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
      confidence: noteConfidence(raw.length * hop, fit) === 'low' || !centreAgrees(raw, idx, hop, fit) ? 'low' : 'high',
    },
    steady: idx,
    vibAmp: fit.fitted ? fit.amp : 0,
    vibRateHz: fit.fitted ? fit.rateHz : null,
  };
}

/**
 * Whether a note's centre is stable: fitted again on the first and on the last CENTRE_CHECK_SHARE of its steady
 * frames (at the same vibrato rate), the two must agree within CENTRE_CHECK_CENTS. A clean note, even under one cycle
 * with a known rate, agrees to a few cents; a short note whose steady part still holds glide or onset residue does not.
 * Checked only on notes shorter than two vibrato cycles (or 0.4 s without vibrato), where it matters.
 */
function centreAgrees(raw: readonly number[], idx: readonly number[], hop: number, fit: { rateHz: number | null; spanSec: number }): boolean {
  const cycles = fit.rateHz ? fit.spanSec * fit.rateHz : fit.spanSec / 0.2;
  if (cycles >= 2) return true;
  const n = raw.length;
  const m = Math.round(n * CENTRE_CHECK_SHARE);
  if (m < 5) return false;
  const a = heldPitchFit(raw.slice(0, m), idx.slice(0, m), hop, fit.rateHz).midi;
  const b = heldPitchFit(raw.slice(n - m), idx.slice(n - m), hop, fit.rateHz).midi;
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) * 100 <= CENTRE_CHECK_CENTS;
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

/** Spans for the frame ranges between consecutive boundaries of [s0, s1) (each range at least two frames). */
function spansBetween(fr: TakeFrames, s0: number, s1: number, cuts: readonly number[], rateHz: number | null): { a: number; b: number; span: NoteSpan | null }[] {
  const out: { a: number; b: number; span: NoteSpan | null }[] = [];
  let a = s0;
  for (const c of [...cuts, s1]) {
    if (c - a >= 2) out.push({ a, b: c, span: buildNote(fr, a, c, NOTE_MIN_SEC, rateHz) });
    a = c;
  }
  return out;
}

/** Straight-line fit of the raw pitch over [i0, i1): value at both ends and R^2 (NaN-aware). */
function rampOf(fr: TakeFrames, i0: number, i1: number): { start: number; end: number; r2: number } | null {
  let n = 0;
  let st = 0;
  let sx = 0;
  for (let k = i0; k < i1; k++) if (!Number.isNaN(fr.midi[k])) {
    n++;
    st += k;
    sx += fr.midi[k];
  }
  if (n < 5) return null;
  const mt = st / n;
  const mx = sx / n;
  let stt = 0;
  let stx = 0;
  let sxx = 0;
  for (let k = i0; k < i1; k++) if (!Number.isNaN(fr.midi[k])) {
    stt += (k - mt) ** 2;
    stx += (k - mt) * (fr.midi[k] - mx);
    sxx += (fr.midi[k] - mx) ** 2;
  }
  if (stt <= 0 || sxx <= 1e-12) return null;
  const slope = stx / stt;
  return { start: mx + slope * (i0 - mt), end: mx + slope * (i1 - 1 - mt), r2: (stx * stx) / (stt * sxx) };
}

/**
 * A short span that is a straight ramp of RAMP_MIN_ST or more (and well beyond the vibrato) heading into the next
 * note (a scoop) or away from the previous one (a fall) is part of that note, not a note of its own.
 */
function rampInto(fr: TakeFrames, sp: NoteSpan, prev: NoteSpan | null, next: NoteSpan | null, vibAmp: number): 'next' | 'prev' | null {
  if ((sp.i1 - sp.i0) * fr.hop > RAMP_MAX_SEC) return null;
  const r = rampOf(fr, sp.i0, sp.i1);
  if (!r || r.r2 < RAMP_MIN_R2 || Math.abs(r.end - r.start) < Math.max(RAMP_MIN_ST, RAMP_VIB_FACTOR * vibAmp)) return null;
  if (next && Math.abs(r.end - next.note.midi) < Math.abs(r.start - next.note.midi) && Math.abs(r.end - next.note.midi) <= RAMP_REACH_ST) return 'next';
  if (prev && Math.abs(r.start - prev.note.midi) < Math.abs(r.end - prev.note.midi) && Math.abs(r.start - prev.note.midi) <= RAMP_REACH_ST) return 'prev';
  return null;
}

/**
 * Notes of a take as frame spans (internal; the scorers need the frame ranges). Two passes: the first finds candidate
 * notes and, from all of them together, the singer's vibrato rate (jointVibratoRate). The second keeps only pitch
 * boundaries that are real steps once that vibrato is fitted across both sides (vibratoStep), so one wide vibrato
 * swing is never split into two notes, folds scoops and falls into their note, and measures every note's centre at
 * the take's vibrato rate.
 */
export function segmentSpans(fr: TakeFrames): NoteSpan[] {
  const stretches = voicedStretches(fr).map(([s0, s1]) => ({ s0, s1, pitch: pitchBoundaries(fr, s0, s1), dips: dipBoundaries(fr, s0, s1) }));
  const merged = (a: readonly number[], b: readonly number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
  const first: NoteSpan[] = [];
  for (const st of stretches) for (const p of spansBetween(fr, st.s0, st.s1, merged(st.pitch, st.dips), null)) if (p.span) first.push(p.span);
  const rate = jointVibratoRate(
    first.map((sp) => ({ values: sp.steady.map((k) => fr.midi[k]), frames: sp.steady })),
    fr.hop,
  );
  const amps = first.map((sp) => sp.vibAmp).filter((a) => a > 0);
  const vibAmp = amps.length ? median(amps) : 0;
  const spans: NoteSpan[] = [];
  const reach = Math.round(VIB_STEP_WINDOW_SEC / fr.hop);
  for (const st of stretches) {
    let cuts = merged(st.pitch, st.dips);
    if (rate !== null) {
      // A pitch boundary stays only when the step is real with the vibrato fitted across it.
      const keep: number[] = [];
      for (let i = 0; i < cuts.length; i++) {
        const c = cuts[i];
        if (st.dips.includes(c)) {
          keep.push(c);
          continue;
        }
        const a = Math.max(keep.length ? keep[keep.length - 1] : st.s0, c - reach);
        const b = Math.min(i + 1 < cuts.length ? cuts[i + 1] : st.s1, c + reach);
        const step = vibratoStep(fr.midi, a, c, b, fr.hop, rate);
        if (step === null || Math.abs(step) * 100 >= SPLIT_CENTS) keep.push(c);
      }
      cuts = keep;
    }
    let parts = spansBetween(fr, st.s0, st.s1, cuts, rate);
    // Scoops into a note and falls off one are part of that note.
    const drop = new Set<number>();
    const built = parts.filter((p) => p.span);
    for (let i = 0; i < built.length; i++) {
      const sp = built[i].span as NoteSpan;
      const into = rampInto(fr, sp, i > 0 ? built[i - 1].span : null, i + 1 < built.length ? built[i + 1].span : null, vibAmp);
      if (into === 'next') drop.add(built[i].b);
      else if (into === 'prev') drop.add(built[i].a);
    }
    if (drop.size) parts = spansBetween(fr, st.s0, st.s1, cuts.filter((c) => !drop.has(c)), rate);
    for (const p of parts) if (p.span) spans.push(p.span);
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

/**
 * Splits one note span in two at the point that best separates two steady pitches (least squares over the two
 * halves), for a two-note take where the singer glided legato from one note to the next and no boundary was found
 * (a narrow semitone, or a unison sung without a break). Each half must hold at least NOTE_MIN_SEC of steady pitch.
 */
export function splitSpanInTwo(fr: TakeFrames, span: NoteSpan, unison = false): [NoteSpan, NoteSpan] | null {
  const { i0, i1 } = span;
  const minLen = Math.round(NOTE_MIN_SEC / fr.hop) + 2;
  if (i1 - i0 < 2 * minLen) return null;
  if (unison) {
    // A unison has no pitch change to find (a "best" split would land on the vibrato onset): split in the middle.
    const mid = i0 + ((i1 - i0) >> 1);
    const ma = buildNote(fr, i0, mid);
    const mb = buildNote(fr, mid, i1);
    return ma && mb ? [ma, mb] : null;
  }
  let best = -1;
  let bestCost = Infinity;
  const vals: number[] = [];
  for (let k = i0; k < i1; k++) vals.push(fr.midi[k]);
  const sse = (a: number, b: number) => {
    let s = 0;
    let n = 0;
    for (let k = a; k < b; k++) if (!Number.isNaN(vals[k])) (s += vals[k]), n++;
    if (!n) return Infinity;
    const m = s / n;
    let e = 0;
    for (let k = a; k < b; k++) if (!Number.isNaN(vals[k])) e += (vals[k] - m) ** 2;
    return e;
  };
  for (let c = minLen; c <= vals.length - minLen; c++) {
    const cost = sse(0, c) + sse(c, vals.length);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  if (best < 0) return null;
  // A unison has no pitch change to find: split it in the middle.
  const a = buildNote(fr, i0, i0 + best);
  const b = buildNote(fr, i0 + best, i1);
  if (a && b) return [a, b];
  const mid = i0 + ((i1 - i0) >> 1);
  const ma = buildNote(fr, i0, mid);
  const mb = buildNote(fr, mid, i1);
  return ma && mb ? [ma, mb] : null;
}
