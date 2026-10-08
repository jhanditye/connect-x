// How far to trust each note of a lead-vocal extraction (mix mode).
//
// The extractor follows the loudest voice-like line, and on a song with the voice level with or under the band some of what it
// reports is the band: a bass or guitar note, a fragment of a chord. Those notes were not sung, so a singer who copies the
// vocal "misses" them. `noteTrust` is the probability that a note is the lead voice, so that a scorer can leave the doubtful ones
// out of "missed" and "wrong note" counts and can say when the reference is only a rough guide (`purity`, `roughGuide`).
//
// A logistic model of six cues, fitted on 4,321 notes from proxy mixes (songMix.ts: chord/bass/drum band, moving bass line,
// backing voices; voice +6 to -6 dB over the band; vibrato 6, 12 and 20 cents; plus four real singing voices over the proxy
// band): the note's length, its level against the clip's loud frames, the extractor's mean confidence over it, the interval
// to the nearest neighbouring note (a sung line moves by steps; a band fragment jumps by an octave or a fifth), whether it
// has a neighbour at all, and the clip's median harmonic share (how much of the spectrum the extracted line explains: it falls
// from 0.46 with the voice 6 dB over the band to 0.24 with the voice 6 dB under it). A note counts as sung when 60% of its
// frames are within 50 cents of the true pitch. Leave-one-condition-out AUC 0.82; at trust >= 0.5 the notes kept are 77% sung
// and hold 88% of the sung ones. Calibrated on synthetic accompaniments and real voices over a synthetic band: read it as a
// ranking, and `purity` as optimistic by up to 0.15 when the voice is under the band.

import type { FrameFeatures, NoteSegment } from '../types';

const WEIGHTS = [0.761, 0.608, -0.136, -1.139, 0.464, 0.428];
const BIAS = 0.473;
const MEAN = [-0.997, -4.86, 0.891, 3.094, 0.047, 0.311];
const SCALE = [0.64, 3.222, 0.073, 2.898, 0.211, 0.098];
/** Neighbouring notes closer than this in time (seconds) count as neighbours. */
const NEIGHBOUR_GAP_SEC = 0.2;
/** Largest interval (semitones) the model distinguishes. */
const MAX_STEP = 12;

/** Below this time-weighted mean trust the extraction is only a rough guide: about a third of what it reports is likely the band. */
export const ROUGH_GUIDE_PURITY = 0.7;

export interface TrustInput {
  notes: NoteSegment[];
  frames: FrameFeatures[];
  /** Extractor's per-frame confidence and level re the clip's 90th percentile (dB), on the same grid as `frames`. */
  confidence: ArrayLike<number>;
  relLevelDb: ArrayLike<number>;
  /** The extractor's clip-level median harmonic share. */
  clipShare: number;
  hopSec: number;
}

function median(v: number[]): number {
  if (v.length === 0) return NaN;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/** Probability (0..1) that each note is the lead voice; same order as `input.notes`. */
export function noteTrust(input: TrustInput): number[] {
  const { notes, frames, confidence, relLevelDb, clipShare, hopSec } = input;
  const out: number[] = [];
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    const i0 = Math.max(0, Math.round(n.start / hopSec));
    const i1 = Math.min(frames.length, Math.round(n.end / hopSec));
    const conf: number[] = [];
    const lev: number[] = [];
    for (let i = i0; i < i1; i++) {
      if (!frames[i].voiced) continue;
      conf.push(confidence[i]);
      lev.push(relLevelDb[i]);
    }
    const prev = k > 0 ? notes[k - 1] : null;
    const next = k + 1 < notes.length ? notes[k + 1] : null;
    const stepPrev = prev && n.start - prev.end < NEIGHBOUR_GAP_SEC ? Math.abs(n.midi - prev.midi) : Infinity;
    const stepNext = next && next.start - n.end < NEIGHBOUR_GAP_SEC ? Math.abs(next.midi - n.midi) : Infinity;
    const step = Math.min(stepPrev, stepNext);
    const x = [
      Math.log(Math.max(n.end - n.start, 1e-3)),
      conf.length > 0 ? median(lev) : MEAN[1],
      conf.length > 0 ? median(conf) : MEAN[2],
      Math.min(step, MAX_STEP),
      step === Infinity ? 1 : 0,
      clipShare,
    ];
    let z = BIAS;
    for (let i = 0; i < x.length; i++) z += (WEIGHTS[i] * (x[i] - MEAN[i])) / SCALE[i];
    out.push(1 / (1 + Math.exp(-z)));
  }
  return out;
}

/** Time-weighted mean trust: the expected share of the extracted singing that is the lead voice (1 for no notes would mislead: 0). */
export function purityOf(notes: NoteSegment[], trust: number[]): number {
  let w = 0;
  let p = 0;
  for (let i = 0; i < notes.length; i++) {
    const d = notes[i].end - notes[i].start;
    w += d;
    p += d * trust[i];
  }
  return w > 0 ? p / w : 0;
}
