// Per-analysis helpers: vibrato-free centre line, fine contour, level contour, window statistics.

import { median, movingAverage, medianFilter } from '../../dsp/stats';
import type { NoteSegment, VoiceAnalysis } from '../../types';

export interface Prep {
  a: VoiceAnalysis;
  hop: number;
  /** MIDI per frame, NaN when unvoiced. Inside notes that carry vibrato it is smoothed over two vibrato periods (cascade of two 1-period boxcars). */
  centre: Float64Array;
  /** MIDI per frame, NaN when unvoiced, 3-frame median only (keeps scoops and falls). */
  fine: Float64Array;
  /** Frame level, dBFS, NaN when unvoiced. */
  level: Float64Array;
}

/** A stretch of pitch this far from the voice's own level around it (semitones) is an error of the pitch tracker, not a note. */
const SPIKE_ST = 9;
/** Real notes are longer than this; a tracker slip (octave or harmonic jump) is not. */
const SPIKE_MAX_SEC = 0.4;
/** The level around a frame is the median of the voiced frames within this many seconds either side. */
const SPIKE_CONTEXT_SEC = 0.5;
/** How close to a whole number of octaves a slip must be to be folded back instead of dropped (semitones). */
const SPIKE_OCTAVE_SLACK = 2.5;

/**
 * Pitch-tracker slips: a short stretch (under 0.4 s) that sits an octave or more away from the voice around it. An octave slip is
 * folded back to the neighbours' octave; any other big jump (a harmonic picked instead of the fundamental) becomes unvoiced.
 * Without this a 150 ms octave error in an otherwise perfect take reads as a note that came in late and ended early. Real
 * leaps and notes are longer than the limit, and vibrato is far below the threshold, so neither is touched.
 */
export function despikeOctaves(m: Float64Array, hop: number): Float64Array {
  const n = m.length;
  const out = Float64Array.from(m);
  const w = Math.max(3, Math.round(SPIKE_CONTEXT_SEC / hop));
  const maxRun = Math.max(1, Math.round(SPIKE_MAX_SEC / hop));
  const level = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(m[i])) continue;
    const vals: number[] = [];
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) if (Number.isFinite(m[k])) vals.push(m[k]);
    level[i] = vals.length >= 5 ? median(vals) : NaN;
  }
  const isOff = (i: number): boolean => Number.isFinite(m[i]) && Number.isFinite(level[i]) && Math.abs(m[i] - level[i]) >= SPIKE_ST;
  let i = 0;
  while (i < n) {
    if (!isOff(i)) {
      i++;
      continue;
    }
    let j = i;
    let last = i;
    // a run may contain a few unvoiced frames; it ends at the first frame that is back on the level
    while (j + 1 < n && (isOff(j + 1) || (!Number.isFinite(m[j + 1]) && j + 3 < n && isOff(j + 2)))) {
      j++;
      if (isOff(j)) last = j;
    }
    if (last - i + 1 <= maxRun) {
      for (let k = i; k <= last; k++) {
        if (!Number.isFinite(m[k])) continue;
        const d = m[k] - level[k];
        const octaves = Math.round(d / 12);
        out[k] = octaves !== 0 && Math.abs(d - 12 * octaves) <= SPIKE_OCTAVE_SLACK ? m[k] - 12 * octaves : NaN;
      }
    }
    i = last + 1;
  }
  return out;
}

export function prepare(a: VoiceAnalysis): Prep {
  const n = a.frames.length;
  const hop = a.hopSec;
  const raw = new Float64Array(n);
  const level = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = a.frames[i];
    const ok = f.voiced && Number.isFinite(f.midi);
    raw[i] = ok ? f.midi : NaN;
    level[i] = f.voiced && Number.isFinite(f.rmsDb) ? f.rmsDb : NaN;
  }
  const fine = medianFilter(despikeOctaves(raw, hop), 3);
  const centre = Float64Array.from(fine);
  for (const nt of a.notes) {
    if (!nt.vibrato) continue;
    const i0 = Math.max(0, Math.round(nt.start / hop));
    const i1 = Math.min(n, Math.round(nt.end / hop));
    if (i1 - i0 < 5) continue;
    const w = Math.max(3, Math.round(1 / nt.vibrato.rateHz / hop));
    const seg = fine.slice(i0, i1);
    const sm = movingAverage(movingAverage(seg, w), w);
    for (let i = i0; i < i1; i++) centre[i] = sm[i - i0];
  }
  return { a, hop, centre, fine, level };
}

/** Frame index range [i0, i1) covering [t0, t1). */
export function range(p: Prep, t0: number, t1: number): [number, number] {
  return [Math.max(0, Math.round(t0 / p.hop)), Math.min(p.centre.length, Math.round(t1 / p.hop))];
}

export function windowValues(arr: Float64Array, p: Prep, t0: number, t1: number): number[] {
  const [i0, i1] = range(p, t0, t1);
  const out: number[] = [];
  for (let i = i0; i < i1; i++) if (Number.isFinite(arr[i])) out.push(arr[i]);
  return out;
}

export function windowMedian(arr: Float64Array, p: Prep, t0: number, t1: number, minN = 3): number {
  const v = windowValues(arr, p, t0, t1);
  return v.length >= minN ? median(v) : NaN;
}

export function windowMean(arr: Float64Array, p: Prep, t0: number, t1: number, minN = 3): number {
  const v = windowValues(arr, p, t0, t1);
  return v.length >= minN ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

/** Linear interpolation of a per-frame array at time t; NaN unless both neighbours are measured. */
export function interpAt(arr: Float64Array, p: Prep, t: number): number {
  const x = t / p.hop;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return NaN;
  const a = arr[i];
  const b = arr[i + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return a + (b - a) * (x - i);
}

/** Note pitch (MIDI): mean of the vibrato-free centre line over the middle 60 % of the note; falls back to the analysis value. */
export function notePitch(p: Prep, n: NoteSegment): number {
  const d = n.end - n.start;
  const m = windowMean(p.centre, p, n.start + 0.2 * d, n.end - 0.2 * d, 3);
  return Number.isFinite(m) ? m : n.midi;
}

/** Pitch (MIDI) read from the centre line inside an arbitrary window (middle 60 %), NaN with < 4 voiced frames. */
export function pitchInWindow(p: Prep, t0: number, t1: number): number {
  const d = t1 - t0;
  if (!(d > 0)) return NaN;
  return windowMedian(p.centre, p, t0 + 0.2 * d, t1 - 0.2 * d, 4);
}

export const midiName = (m: number): string => {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const r = Math.round(m);
  return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
};
