// Note segmentation: split each phrase into stable-pitch events, robustly to vibrato, then turn
// the longer events into NoteSegments with a global tuning correction.

import { median, medianFilter, movingAverage } from '../dsp/stats';
import type { FrameFeatures, NoteSegment, RegisterLabel } from '../types';
import type { PhraseSpan } from './phrases';
import { detectVibrato } from './vibrato';

/** A stable-pitch event inside a phrase. Frame range [i0, i1). */
export interface NoteEvent {
  i0: number;
  i1: number;
  start: number;
  end: number;
  /** Median fractional MIDI over the middle 60 % of the event's voiced frames. */
  midi: number;
  phraseIndex: number;
}

/** A pitch change counts as a new note when it exceeds this many semitones... */
const SPLIT_SEMITONES = 0.7;
/** ...every frame of the next STAY_SEC stays beyond this fraction of it on the same side... */
const STAY_SEC = 0.05;
const STAY_FRACTION = 0.7;
/**
 * ...and a 200 ms moving average taken just after the change differs from the same average just
 * before it by this much. 200 ms is one cycle of a 5 Hz vibrato, so the average cancels most of
 * any 4-8.5 Hz vibrato (residual <= ~25 % of its extent). A vibrato peak can poke past the split
 * threshold for tens of ms (a +/-120 cent vibrato at 4.5 Hz stays beyond 0.7 st for ~67 ms), but
 * the averages either side of it differ by well under 0.45 st, whereas a real step of >= 1 st
 * moves them apart by more than that even for 120 ms run notes. Comparing two smoothed levels
 * (rather than one with the current note's reference) also stops a young note, whose reference
 * is still a vibrato phase, from cascading into a split at every cycle.
 */
const SMOOTH_SEC = 0.2;
const SMOOTH_MOVE_SEMITONES = 0.45;
/** Near either end of a stretch the full smoothing windows do not fit; demand a larger move there. */
const EDGE_MOVE_SEMITONES = 1.1;
/** Reference pitch of the current note: median of the last 300 ms (follows slow drift, ignores vibrato). */
const REF_SEC = 0.3;
/** Fine contour: a 3-frame median removes single-frame glitches without blurring fast runs. */
const FINE_FRAMES = 3;
/** Unvoiced gaps at least this long end a note even when the pitch continues. */
const GAP_SPLIT_SEC = 0.04;
/** Adjacent events closer than this in pitch are one note (a split caused by a transient). */
const MERGE_SEMITONES = 0.5;
/** Shortest event kept at all (runs are built from events down to this length). */
export const EVENT_MIN_SEC = 0.05;
/** Shortest event reported as a NoteSegment (SPEC: ~120 ms; 0.1 s keeps the notes of a fast run). */
export const NOTE_MIN_SEC = 0.1;

function middleMedian(frames: FrameFeatures[], i0: number, i1: number): number {
  const vals: number[] = [];
  for (let i = i0; i < i1; i++) if (frames[i].voiced) vals.push(frames[i].midi);
  if (vals.length === 0) return NaN;
  const cut = Math.floor(vals.length * 0.2);
  const mid = vals.length - 2 * cut >= 1 ? vals.slice(cut, vals.length - cut) : vals;
  return median(mid);
}

/** Split a frame range into voiced stretches separated by unvoiced gaps >= GAP_SPLIT_SEC. */
function stretches(frames: FrameFeatures[], i0: number, i1: number, hopSec: number): [number, number][] {
  const out: [number, number][] = [];
  const maxGap = Math.max(1, Math.round(GAP_SPLIT_SEC / hopSec));
  let start = -1;
  let lastVoiced = -1;
  for (let i = i0; i < i1; i++) {
    if (!frames[i].voiced) continue;
    if (start < 0) start = i;
    else if (i - lastVoiced - 1 >= maxGap) {
      out.push([start, lastVoiced + 1]);
      start = i;
    }
    lastVoiced = i;
  }
  if (start >= 0) out.push([start, lastVoiced + 1]);
  return out;
}

/** Boundaries (frame indices) where the pitch moves to a new stable level within [a, b). */
function splitPoints(midi: Float64Array, a: number, b: number, hopSec: number): number[] {
  const seg = midi.subarray(a, b);
  const fine = medianFilter(seg, FINE_FRAMES);
  const smooth = movingAverage(seg, Math.max(3, Math.round(SMOOTH_SEC / hopSec) | 1));
  const stay = Math.max(2, Math.round(STAY_SEC / hopSec));
  const refLen = Math.max(3, Math.round(REF_SEC / hopSec));
  const halfSmooth = Math.round(SMOOTH_SEC / hopSec / 2);
  const splits: number[] = [];
  let noteStart = 0;
  const n = seg.length;
  for (let i = 1; i < n; i++) {
    const v = fine[i];
    // A new note must last at least `stay` frames before it can split again; otherwise the rest of
    // the glide into it would be cut off as a separate sliver.
    if (Number.isNaN(v) || (noteStart > 0 && i - noteStart < stay)) continue;
    const ref = median(fine.subarray(Math.max(noteStart, i - refLen), i));
    if (Number.isNaN(ref)) continue;
    const d = v - ref;
    if (Math.abs(d) <= SPLIT_SEMITONES) continue;
    const sign = Math.sign(d);
    let ok = i + stay <= n;
    for (let j = i; ok && j < Math.min(n, i + stay); j++) {
      const w = fine[j];
      if (Number.isNaN(w)) continue;
      if ((w - ref) * sign < SPLIT_SEMITONES * STAY_FRACTION) ok = false;
    }
    if (!ok) continue;
    // Full smoothing windows either side of the change when the stretch allows; near its ends the
    // moving average is truncated (and so biased by the vibrato phase), so compare plain medians
    // of up to ~200 ms either side against a stricter threshold instead.
    const afterIdx = i + halfSmooth;
    const beforeIdx = i - halfSmooth - 1;
    let moved: boolean;
    if (beforeIdx >= halfSmooth && afterIdx <= n - 1 - halfSmooth) {
      moved = (smooth[afterIdx] - smooth[beforeIdx]) * sign >= SMOOTH_MOVE_SEMITONES;
    } else {
      const before = median(fine.subarray(Math.max(noteStart, i - 2 * halfSmooth - 1), i));
      const after = median(fine.subarray(i, Math.min(n, i + 2 * halfSmooth + 1)));
      moved = (after - before) * sign >= EDGE_MOVE_SEMITONES;
    }
    if (!moved) continue;
    splits.push(a + i);
    noteStart = i;
  }
  return splits;
}

/** Segment every phrase into note events (>= EVENT_MIN_SEC), merging adjacent same-pitch events. */
export function segmentNotes(frames: FrameFeatures[], phrases: PhraseSpan[], hopSec: number): NoteEvent[] {
  const midi = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) midi[i] = frames[i].voiced ? frames[i].midi : NaN;
  const minFrames = Math.max(1, Math.round(EVENT_MIN_SEC / hopSec));
  const events: NoteEvent[] = [];
  phrases.forEach((p, phraseIndex) => {
    const raw: [number, number][] = [];
    for (const [a, b] of stretches(frames, p.i0, p.i1, hopSec)) {
      let s = a;
      for (const cut of splitPoints(midi, a, b, hopSec)) {
        raw.push([s, cut]);
        s = cut;
      }
      raw.push([s, b]);
    }
    const phraseEvents: NoteEvent[] = [];
    for (const [i0, i1] of raw) {
      const m = middleMedian(frames, i0, i1);
      if (Number.isNaN(m)) continue;
      const prev = phraseEvents[phraseEvents.length - 1];
      if (prev && prev.i1 === i0 && Math.abs(prev.midi - m) < MERGE_SEMITONES) {
        prev.i1 = i1;
        prev.end = frames[i1 - 1].t + hopSec;
        prev.midi = middleMedian(frames, prev.i0, i1);
        continue;
      }
      phraseEvents.push({ i0, i1, start: frames[i0].t, end: frames[i1 - 1].t + hopSec, midi: m, phraseIndex });
    }
    for (const e of phraseEvents) if (e.i1 - e.i0 >= minFrames) events.push(e);
  });
  return events;
}

/**
 * Global tuning offset (cents, -50..50): duration-weighted circular mean of each note's deviation
 * from the equal-tempered grid. Circular because -49 and +49 cents are 2 cents apart on the grid.
 * Returns 0 with less than a second of notes, where the estimate would just be the error of one
 * or two notes.
 */
export function tuningOffsetCents(notes: { midi: number; duration: number }[]): number {
  let c = 0;
  let s = 0;
  let total = 0;
  for (const nt of notes) {
    if (!Number.isFinite(nt.midi) || !(nt.duration > 0)) continue;
    const angle = 2 * Math.PI * (nt.midi - Math.round(nt.midi));
    c += nt.duration * Math.cos(angle);
    s += nt.duration * Math.sin(angle);
    total += nt.duration;
  }
  if (total < 1 || (c === 0 && s === 0)) return 0;
  return (Math.atan2(s, c) / (2 * Math.PI)) * 100;
}

function majorityRegister(frames: FrameFeatures[], i0: number, i1: number): RegisterLabel | null {
  const counts = { chest: 0, mix: 0, head: 0 };
  for (let i = i0; i < i1; i++) {
    const r = frames[i].register;
    if (r) counts[r]++;
  }
  const total = counts.chest + counts.mix + counts.head;
  if (total === 0) return null;
  if (counts.chest >= counts.mix && counts.chest >= counts.head) return 'chest';
  return counts.mix >= counts.head ? 'mix' : 'head';
}

function meanRms(frames: FrameFeatures[], i0: number, i1: number): number {
  let sum = 0;
  let n = 0;
  for (let i = i0; i < i1; i++) {
    if (!frames[i].voiced) continue;
    sum += frames[i].rmsDb;
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

/** NoteSegments for events of at least NOTE_MIN_SEC, with tuning correction and vibrato. */
export function buildNoteSegments(
  frames: FrameFeatures[],
  events: NoteEvent[],
  hopSec: number,
): { notes: NoteSegment[]; tuningOffsetCents: number } {
  const long = events.filter((e) => e.end - e.start >= NOTE_MIN_SEC - 1e-9);
  const offset = tuningOffsetCents(long.map((e) => ({ midi: e.midi, duration: e.end - e.start })));
  const notes = long.map((e): NoteSegment => {
    const corrected = e.midi - offset / 100;
    const nearest = Math.round(corrected);
    return {
      start: e.start,
      end: e.end,
      midi: e.midi,
      nearestMidi: nearest,
      centsOff: (corrected - nearest) * 100,
      vibrato: detectVibrato(frames, e.i0, e.i1, e.midi, hopSec),
      register: majorityRegister(frames, e.i0, e.i1),
      meanRmsDb: meanRms(frames, e.i0, e.i1),
    };
  });
  return { notes, tuningOffsetCents: offset };
}
