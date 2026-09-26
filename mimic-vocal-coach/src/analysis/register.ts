// Register estimate (chest / mix / head) per voiced frame, from acoustic proxies.
//
// This is an estimate, not a measurement: registers are a laryngeal mechanism that audio can only
// hint at. The heuristic, per voiced frame:
//
// 1. Lightness score S in 0..1 (0 = chest-like, 1 = head/falsetto-like):
//      S = 0.65 * h + 0.35 * a + l
//    h  = normalised H1-H2 (see features.normalizedH1H2) mapped 6 dB -> 0, 28 dB -> 1. A strong
//         first harmonic relative to the second is the classic acoustic correlate of lighter,
//         thinner vocal-fold contact (falsetto/head); chest voice has more energy in H2 and up.
//    a  = aspiration index (HNR and CPP must agree there is breath noise): falsetto and light
//         head voice are usually less completely closed than chest.
//    l  = +/-0.1 from loudness relative to the take's median voiced level (10 dB softer -> +0.1):
//         at a given pitch, head voice is usually softer and chest-pulled notes louder.
//    Spectral tilt and alpha ratio are not used here: on this analysis they are dominated by the
//    vowel (/a/ vs /o/ differ by ~20 dB in alpha ratio) and by aspiration noise (breath flattens
//    measured tilt), so they said more about the vowel than about the register. They feed the
//    brightness index instead.
// 2. Label: S < 0.15 chest, S >= 0.5 head, otherwise mix. Calibrated on the synthesiser
//    (src/testing/synth.ts), G3-A4 on /a/ and /o/: a chest-like source (tilt -8 dB/oct, no H1
//    boost) scores 0-0.12; a light mix (tilt -13, H1 +3 dB, breath 0.1) mostly 0.2-0.4; falsetto
//    (tilt -20, H1 +10 dB, breath 0.35) 0.65-0.85. Over a phrase through the baritone passaggio
//    the majority labels come out chest / mix / head respectively (see register.test.ts).
// 3. Pitch prior: more than 3 semitones below the passaggio zone a mix is not meaningful and chest
//    is by far the likeliest mechanism, so the frame is chest unless S >= 0.7 (strongly head-like).
// 4. Labels are smoothed with a majority filter over ~130 ms within each voiced stretch, so single
//    frames do not flicker between registers.
//
// Known limits, all from H1-H2 not being formant-corrected:
// - Close vowels (/i/, /u/, and /e/ from about E4 up) put F1 on or near H1 and read as head for
//   any voice on the synthesiser. Register readings are only trustworthy on open vowels
//   ("ah", "oh", "uh"), which is also how mix is usually practised.
// - Where H2 sits on F1 (about F#4-G4 on /a/, D4 on /o/) a light mix can dip to "chest" for a
//   note; the phrase-level shares are still right.
// - A very breathy chest voice can read as mix or head in the passaggio.
// The UI presents the result as an estimate.

import type { FrameFeatures, PassaggioZone, RegisterLabel } from '../types';
import { clamp, median } from '../dsp/stats';
import type { FrameTrack } from './features';

const H_LO_DB = 6;
const H_HI_DB = 28;
const W_H = 0.65;
const W_ASP = 0.35;
const LOUD_SPAN_DB = 10;
const W_LOUD = 0.1;
export const CHEST_MAX_SCORE = 0.15;
export const HEAD_MIN_SCORE = 0.5;
const STRONG_HEAD_SCORE = 0.7;
const LOW_PRIOR_SEMITONES = 3;
const SMOOTH_SEC = 0.13;

/** Lightness score for one voiced frame (0 = chest-like, 1 = head-like); NaN if features are missing. */
export function lightnessScore(h1h2NormDb: number, aspiration: number, relLoudnessDb: number): number {
  if (Number.isNaN(h1h2NormDb) || Number.isNaN(aspiration)) return NaN;
  const h = clamp((h1h2NormDb - H_LO_DB) / (H_HI_DB - H_LO_DB), 0, 1);
  const l = Number.isNaN(relLoudnessDb) ? 0 : W_LOUD * clamp(-relLoudnessDb / LOUD_SPAN_DB, -1, 1);
  return clamp(W_H * h + W_ASP * aspiration + l, 0, 1);
}

/** Maps a lightness score and pitch to a register label (before smoothing). */
export function labelFromScore(score: number, midi: number, zone: PassaggioZone): RegisterLabel | null {
  if (Number.isNaN(score) || Number.isNaN(midi)) return null;
  if (midi < zone.lowMidi - LOW_PRIOR_SEMITONES) return score >= STRONG_HEAD_SCORE ? 'head' : 'chest';
  if (score < CHEST_MAX_SCORE) return 'chest';
  if (score >= HEAD_MIN_SCORE) return 'head';
  return 'mix';
}

/**
 * Majority filter over labelled frames within +/- half a window, not crossing unvoiced frames.
 * Ties keep the frame's own label.
 */
export function smoothLabels(labels: (RegisterLabel | null)[], windowFrames: number): (RegisterLabel | null)[] {
  const n = labels.length;
  const out = labels.slice();
  const half = Math.max(1, Math.floor(windowFrames / 2));
  let i = 0;
  while (i < n) {
    if (labels[i] === null) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && labels[j] !== null) j++;
    // Stretch [i, j): prefix counts make each window O(1).
    const len = j - i;
    const cChest = new Int32Array(len + 1);
    const cMix = new Int32Array(len + 1);
    const cHead = new Int32Array(len + 1);
    for (let k = 0; k < len; k++) {
      const l = labels[i + k];
      cChest[k + 1] = cChest[k] + (l === 'chest' ? 1 : 0);
      cMix[k + 1] = cMix[k] + (l === 'mix' ? 1 : 0);
      cHead[k + 1] = cHead[k] + (l === 'head' ? 1 : 0);
    }
    for (let k = 0; k < len; k++) {
      const lo = Math.max(0, k - half);
      const hi = Math.min(len, k + half + 1);
      const counts: [RegisterLabel, number][] = [
        ['chest', cChest[hi] - cChest[lo]],
        ['mix', cMix[hi] - cMix[lo]],
        ['head', cHead[hi] - cHead[lo]],
      ];
      const own = labels[i + k] as RegisterLabel;
      let best: RegisterLabel = own;
      let bestCount = counts.find((c) => c[0] === own)?.[1] ?? 0;
      for (const [label, count] of counts) {
        if (count > bestCount) {
          best = label;
          bestCount = count;
        }
      }
      out[i + k] = best;
    }
    i = j;
  }
  return out;
}

/**
 * Fills `frame.register` for every voiced frame of the track (null where features are missing).
 * Returns the per-frame lightness scores (NaN where not measured) for flip detection.
 */
export function estimateRegisters(track: FrameTrack, zone: PassaggioZone): Float64Array {
  const { frames } = track;
  const voicedLevels: number[] = [];
  for (const f of frames) if (f.voiced) voicedLevels.push(f.rmsDb);
  const medianLevel = median(voicedLevels);
  const scores = new Float64Array(frames.length).fill(NaN);
  const raw: (RegisterLabel | null)[] = frames.map((f: FrameFeatures, i) => {
    if (!f.voiced) return null;
    scores[i] = lightnessScore(track.h1h2Norm[i], track.aspiration[i], f.rmsDb - medianLevel);
    return labelFromScore(scores[i], f.midi, zone);
  });
  const windowFrames = Math.max(3, Math.round(SMOOTH_SEC / track.hopSec) | 1);
  const smoothed = smoothLabels(raw, windowFrames);
  for (let i = 0; i < frames.length; i++) frames[i].register = frames[i].voiced ? smoothed[i] : null;
  return scores;
}

/** Register shares among labelled frames (all zero when none are labelled). */
export function registerShares(frames: FrameFeatures[], filter: (f: FrameFeatures) => boolean = () => true): {
  chest: number;
  mix: number;
  head: number;
  count: number;
} {
  let chest = 0;
  let mix = 0;
  let head = 0;
  for (const f of frames) {
    if (!f.voiced || f.register === null || !filter(f)) continue;
    if (f.register === 'chest') chest++;
    else if (f.register === 'mix') mix++;
    else head++;
  }
  const count = chest + mix + head;
  if (count === 0) return { chest: 0, mix: 0, head: 0, count: 0 };
  return { chest: chest / count, mix: mix / count, head: head / count, count };
}

const FLIP_LOOKBACK_SEC = 0.15;
const FLIP_MIN_RISE_SEMITONES = 2;
/**
 * Rises of more than a minor seventh are rejected. On real recordings every such "flip" was a
 * tracker jump: an octave error (rise ~12), or the tracker switching between the voice and an
 * instrument or bass line (12-25). Falsetto flips in this repertoire are mostly 3-9 semitone
 * moves within a line. The price is that a genuine flip on an octave leap is not counted; it
 * cannot be told apart from an octave error by pitch and voice quality alone.
 */
const FLIP_MAX_RISE_SEMITONES = 10.5;
/** Head must hold this long after the switch to count (the smoother already removes blips). */
const FLIP_MIN_HOLD_SEC = 0.05;
/**
 * A flip is an abrupt change of voice quality, so the lightness score must also jump: median over
 * the first 50 ms of head minus median over the 150 ms before. A real chest-to-falsetto flip on
 * the synthesiser jumps by ~0.5; a label that drifts across the mix/head boundary as a melody
 * climbs moves by well under 0.2 from one note to the next.
 */
const FLIP_MIN_SCORE_JUMP = 0.2;

/**
 * Register flips: a switch into head from chest/mix (within the same voiced stretch or across a
 * gap of at most the lookback) together with a pitch rise of 2-10.5 semitones and a jump in
 * lightness within ~150 ms. Returns the flip times.
 */
export function detectFlips(frames: FrameFeatures[], scores: Float64Array, hopSec: number): number[] {
  const flips: number[] = [];
  const back = Math.max(1, Math.round(FLIP_LOOKBACK_SEC / hopSec));
  const hold = Math.max(1, Math.round(FLIP_MIN_HOLD_SEC / hopSec));
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    if (f.register !== 'head') continue;
    // Previous labelled frame must be chest/mix, within the lookback.
    let p = i - 1;
    while (p >= 0 && i - p <= back && frames[p].register === null) p--;
    if (p < 0 || i - p > back) continue;
    const prev = frames[p].register;
    if (prev !== 'chest' && prev !== 'mix') continue;
    let held = 0;
    for (let k = i; k < frames.length && frames[k].register === 'head' && held < hold; k++) held++;
    if (held < hold) continue;
    let lowBefore = Infinity;
    const scoreBefore: number[] = [];
    for (let k = Math.max(0, i - back); k < i; k++) {
      if (!frames[k].voiced) continue;
      if (frames[k].midi < lowBefore) lowBefore = frames[k].midi;
      scoreBefore.push(scores[k]);
    }
    const midiAfter: number[] = [];
    const scoreAfter: number[] = [];
    for (let k = i; k < Math.min(frames.length, i + hold); k++) {
      if (!frames[k].voiced) continue;
      midiAfter.push(frames[k].midi);
      scoreAfter.push(scores[k]);
    }
    const rise = median(midiAfter) - lowBefore;
    const jump = median(scoreAfter) - median(scoreBefore);
    if (rise < FLIP_MIN_RISE_SEMITONES || rise > FLIP_MAX_RISE_SEMITONES) continue;
    if (jump >= FLIP_MIN_SCORE_JUMP) flips.push(f.t);
  }
  return flips;
}
