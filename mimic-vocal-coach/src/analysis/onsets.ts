// Phrase-onset classification: breathy (aspirated), glottal (hard) or balanced.
//
// - Breathy: at least 40 ms of aspiration-like sound right before voicing starts: unvoiced frames
//   that are clearly above the noise floor (and not far below the phrase) with low periodicity.
//   Air is flowing before the folds start to vibrate.
// - Glottal: the level jumps from silence to near the phrase level within ~12 ms and the first
//   voiced frames are already strongly periodic. The folds were closed and start vibrating
//   abruptly, which on an envelope looks like a step.
// - Balanced: everything else (a clean onset that swells in over a few tens of ms).
//
// Rise time is measured on a sample-level RMS envelope (window = one period of the onset pitch,
// 4-12 ms, 1 ms hop), from -20 dB to -3 dB relative to the level of the phrase's first 200 ms. A
// moving RMS turns an instantaneous step into a ~0.5-window rise (<= 6 ms), while a 30 ms linear
// fade-in reads ~18 ms, so 12 ms separates them.

import type { FrameFeatures, Onset, OnsetType } from '../types';
import { median } from '../dsp/stats';
import type { PhraseSpan } from './phrases';

const ASPIRATION_MIN_SEC = 0.04;
const ASPIRATION_ABOVE_FLOOR_DB = 12;
const ASPIRATION_BELOW_PHRASE_DB = 40;
const ASPIRATION_MAX_PERIODICITY = 0.5;
/** Frames right before voicing may mix the tone's first cycles with the air; skip up to this many. */
const TRANSITION_FRAMES = 2;
const PHRASE_LEVEL_SEC = 0.2;
const GLOTTAL_MAX_RISE_SEC = 0.012;
/**
 * "Immediately periodic": the first three voiced frames reach 0.75, or 85 % of the phrase's own
 * median periodicity when that is lower (a raspy voice is never very periodic, but a hard onset
 * still reaches its steady state at once).
 */
const GLOTTAL_MIN_PERIODICITY = 0.75;
const GLOTTAL_RELATIVE_PERIODICITY = 0.85;
const RISE_LOW_DB = 20;
const RISE_HIGH_DB = 3;
const SEARCH_BEFORE_SEC = 0.06;
const SEARCH_AFTER_SEC = 0.1;

/** Median level and periodicity of the phrase's first 200 ms of voiced frames. */
function phraseStart(frames: FrameFeatures[], p: PhraseSpan, hopSec: number): { levelDb: number; periodicity: number } {
  const n = Math.max(1, Math.round(PHRASE_LEVEL_SEC / hopSec));
  const levels: number[] = [];
  const per: number[] = [];
  for (let i = p.i0; i < Math.min(p.i1, p.i0 + n); i++) {
    if (!frames[i].voiced) continue;
    levels.push(frames[i].rmsDb);
    per.push(frames[i].periodicity);
  }
  return { levelDb: median(levels), periodicity: median(per) };
}

function aspirationBefore(frames: FrameFeatures[], v: number, gateDb: number): number {
  let count = 0;
  let skipped = 0;
  for (let j = v - 1; j >= 0 && !frames[j].voiced; j--) {
    const f = frames[j];
    const breathLike = f.rmsDb >= gateDb && f.periodicity < ASPIRATION_MAX_PERIODICITY;
    if (breathLike) count++;
    else if (count === 0 && skipped < TRANSITION_FRAMES) skipped++;
    else break;
  }
  return count;
}

/** Time (s) the RMS envelope takes to climb from -20 dB to -3 dB of `levelDb` around `t`; NaN if not found. */
export function riseTimeSec(x: Float32Array, sampleRate: number, t: number, f0: number, levelDb: number): number {
  const period = f0 > 0 ? 1 / f0 : 0.008;
  const win = Math.max(4, Math.min(12, Math.round(period * 1000))) / 1000;
  const w = Math.max(1, Math.round(win * sampleRate));
  const hop = Math.max(1, Math.round(0.001 * sampleRate));
  const from = Math.max(0, Math.round((t - SEARCH_BEFORE_SEC) * sampleRate));
  const to = Math.min(x.length - w, Math.round((t + SEARCH_AFTER_SEC) * sampleRate));
  if (to <= from) return NaN;
  const hi = levelDb - RISE_HIGH_DB;
  const lo = levelDb - RISE_LOW_DB;
  let lastLow = -1;
  for (let s = from; s <= to; s += hop) {
    let e = 0;
    for (let k = 0; k < w; k++) e += x[s + k] * x[s + k];
    const db = 10 * Math.log10(e / w + 1e-20);
    if (db < lo) lastLow = s;
    else if (db >= hi) return lastLow < 0 ? NaN : (s - lastLow) / sampleRate;
  }
  return NaN;
}

export function classifyOnset(
  x: Float32Array,
  sampleRate: number,
  frames: FrameFeatures[],
  p: PhraseSpan,
  noiseFloorDb: number,
  hopSec: number,
): OnsetType {
  const v = p.i0;
  const start = phraseStart(frames, p, hopSec);
  const level = start.levelDb;
  if (Number.isNaN(level)) return 'balanced';
  const gate = Math.max(noiseFloorDb + ASPIRATION_ABOVE_FLOOR_DB, level - ASPIRATION_BELOW_PHRASE_DB);
  if (aspirationBefore(frames, v, gate) * hopSec >= ASPIRATION_MIN_SEC - 1e-9) return 'breathy';

  const rise = riseTimeSec(x, sampleRate, frames[v].t, frames[v].f0, level);
  let per = 0;
  let n = 0;
  for (let i = v; i < Math.min(p.i1, v + 3); i++) {
    per += frames[i].periodicity;
    n++;
  }
  const needed = Math.min(GLOTTAL_MIN_PERIODICITY, GLOTTAL_RELATIVE_PERIODICITY * start.periodicity);
  if (rise <= GLOTTAL_MAX_RISE_SEC && n > 0 && per / n >= needed) return 'glottal';
  return 'balanced';
}

export function classifyOnsets(
  x: Float32Array,
  sampleRate: number,
  frames: FrameFeatures[],
  phrases: PhraseSpan[],
  noiseFloorDb: number,
  hopSec: number,
): Onset[] {
  return phrases.map((p) => ({ t: p.start, type: classifyOnset(x, sampleRate, frames, p, noiseFloorDb, hopSec) }));
}
