// Transition times that do not depend on the note segmentation or on pitch accuracy.
//  - gap transitions: the start / end of a voiced run (a breath, consonant gap or phrase edge), found from the voicing track.
//  - step transitions: the moment the pitch moves to the next note, found as the peak of  dir * (median(next 80 ms) - median(previous 80 ms))
//    of the vibrato-free contour. The same detector runs on the reference and on the attempt, so any bias cancels.

import { median } from '../../dsp/stats';
import type { Prep } from './contour';

const SIDE = 0.08;
const MIN_STEP = 0.35; // semitones

function sideMedian(p: Prep, t0: number, t1: number): number {
  const i0 = Math.max(0, Math.round(t0 / p.hop));
  const i1 = Math.min(p.centre.length, Math.round(t1 / p.hop));
  const v: number[] = [];
  for (let i = i0; i < i1; i++) if (Number.isFinite(p.centre[i])) v.push(p.centre[i]);
  return v.length >= 3 ? median(v) : NaN;
}

/**
 * Time of the pitch step in direction `dir` (+1 up, -1 down) within tc +- half; null when there is no clear step. Among the local
 * peaks of the step statistic that reach 75 % of the largest, the one nearest `tc` wins, so a fall-off shortly before the step
 * (or a scoop after it) cannot pull the reading away from the step itself.
 */
export function stepTime(p: Prep, tc: number, half: number, dir: number): number | null {
  const ts: number[] = [];
  const ss: number[] = [];
  for (let t = tc - half; t <= tc + half + 1e-9; t += p.hop) {
    const a = sideMedian(p, t - SIDE, t);
    const b = sideMedian(p, t, t + SIDE);
    ts.push(t);
    ss.push(Number.isFinite(a) && Number.isFinite(b) ? dir * (b - a) : -Infinity);
  }
  const top = Math.max(...ss);
  if (!(top >= MIN_STEP)) return null;
  let best = -1;
  for (let i = 0; i < ss.length; i++) {
    const isPeak = ss[i] >= 0.75 * top && (i === 0 || ss[i] >= ss[i - 1]) && (i === ss.length - 1 || ss[i] >= ss[i + 1]);
    if (isPeak && (best < 0 || Math.abs(ts[i] - tc) < Math.abs(ts[best] - tc))) best = i;
  }
  return best >= 0 ? ts[best] : null;
}

export interface Runs {
  starts: number[];
  ends: number[];
}

/** Voiced runs (gaps shorter than 60 ms are bridged). */
export function voicedRuns(p: Prep): Runs {
  const starts: number[] = [];
  const ends: number[] = [];
  const maxGap = Math.max(1, Math.round(0.06 / p.hop));
  let start = -1;
  let last = -1;
  for (let i = 0; i < p.centre.length; i++) {
    if (!Number.isFinite(p.centre[i])) continue;
    if (start < 0) start = i;
    else if (i - last - 1 >= maxGap) {
      starts.push(start * p.hop);
      ends.push((last + 1) * p.hop);
      start = i;
    }
    last = i;
  }
  if (start >= 0) {
    starts.push(start * p.hop);
    ends.push((last + 1) * p.hop);
  }
  return { starts, ends };
}

export function nearest(xs: number[], t: number, within: number): number | null {
  let best: number | null = null;
  for (const x of xs) if (Math.abs(x - t) <= within && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x;
  return best;
}

const runCache = new WeakMap<Prep, Runs>();
function runsOf(p: Prep): Runs {
  let r = runCache.get(p);
  if (!r) runCache.set(p, (r = voicedRuns(p)));
  return r;
}

/**
 * Where a note that runs into the next one actually stops sounding: when the voice pauses for >= 0.1 s right before the next
 * entrance (a note cut short, then the next one entered after a gap) that is the end of the previous voiced run; otherwise the
 * next entrance itself.
 */
export function soundingEnd(p: Prep, tNext: number): number {
  const runs = runsOf(p);
  let idx = -1;
  for (let i = 0; i < runs.starts.length; i++) if (Math.abs(runs.starts[i] - tNext) <= 0.15 && (idx < 0 || Math.abs(runs.starts[i] - tNext) < Math.abs(runs.starts[idx] - tNext))) idx = i;
  if (idx > 0 && runs.starts[idx] - runs.ends[idx - 1] >= 0.1) return runs.ends[idx - 1];
  return tNext;
}
