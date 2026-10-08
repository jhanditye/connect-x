// Contour-first alignment of an attempt to a reference phrase.
//
// Why contour-first: the analysis's note segmentation is unstable on real voices (glides, scoops, portamento: the same audio
// re-rendered can come out as one note or two), so nothing in the score depends on the attempt's own note list. Instead:
//
//   1. Key shift T. Candidates (the shift compareToReference found, the best few from a pitch-only note-sequence search, and a
//      median-based guess, each with its octave neighbours) are each scored by the cost of a subsequence DTW of the two
//      vibrato-free pitch contours; the cheapest wins (the DTW shift wins ties). compareToReference's own search can lock onto
//      a wrong shift for a partial attempt, which is why it is only one candidate.
//   2. A subsequence DTW (every bin of the shorter contour is aligned; the longer one may start/end anywhere; unvoiced time is
//      dropped from both, so rests and lead-in silence do not matter) gives, for every reference bin, the attempt bins it maps to.
//   3. Per reference note: mapped attempt window, per-bin pitch errors, coverage, collapse (many reference bins squeezed into few
//      attempt bins = the note was skipped).
//   4. Timing is read at "transition" onsets only (after a rest, or a pitch step of >= 0.8 semitone) where the DTW corner is sharp,
//      and judged against a RIGID model  attemptT = lag + tempo * refT  (Theil-Sen), so lag and overall speed are not errors.

import { median } from '../../dsp/stats';
import { notePitch, type Prep } from './contour';
import { MIN_PAIRS_FOR_TEMPO, MIN_SPAN_FOR_TEMPO_SEC } from './constants';
import { nearest, stepTime, voicedRuns } from './transitions';
import { foldOctave, theilSen } from './util';

const COST_CAP = 3; // semitones
const STEP_PENALTY = 0.08;
/** Cost per target bin left unaligned at either end: mild, so a nearly complete take covers its first and last notes, but a partial take can still sit anywhere. */
const SKIP_PENALTY = 0.1;
const MAX_CELLS = 3e6;
/** Second pitch reading at the time model (see step 5 of alignContours): how far the mapped note window may stray from the model, and which part of the note is read. */
const RIGID_START_TOL = 0.09;
const RIGID_END_TOL = 0.15;
const RIGID_TRIM = 0.2;
const RIGID_STABLE_ST = 0.24;
const RIGID_MIN_BINS = 3;
const RIGID_AGREE_CENTS = 100;
/** A transposition of more than this many semitones away from an octave multiple is never second-guessed. */
const KEY_SNAP_MAX_SEMITONES = 2;
/** A take is "tidy in its key" when this share of its aligned frames sit within KEY_TIDY_CENTS of one constant offset. */
const KEY_TIDY_SHARE = 0.7;
const KEY_TIDY_CENTS = 25;

export interface Contour {
  /** Bin centre times (s) of voiced bins only. */
  t: Float64Array;
  /** Vibrato-free pitch, MIDI. */
  m: Float64Array;
}

/** Voiced-only pooled contour: median of the centre line over `step`-second bins, kept when at least half the frames are voiced. */
export function pooled(p: Prep, step: number): Contour {
  const ts: number[] = [];
  const ms: number[] = [];
  const per = Math.max(1, Math.round(step / p.hop));
  for (let i0 = 0; i0 < p.centre.length; i0 += per) {
    const vals: number[] = [];
    for (let i = i0; i < Math.min(p.centre.length, i0 + per); i++) if (Number.isFinite(p.centre[i])) vals.push(p.centre[i]);
    if (vals.length * 2 >= per && vals.length > 0) {
      ts.push((i0 + per / 2) * p.hop);
      ms.push(median(vals));
    }
  }
  return { t: Float64Array.from(ts), m: Float64Array.from(ms) };
}

const local = (a: number, b: number): number => {
  const d = a > b ? a - b : b - a;
  return d < COST_CAP ? d : COST_CAP;
};

/**
 * DTW with slope limits. All of q is aligned. Moves into cell (i, j): diagonal from (i-1, j-1) for free, or from (i-1, j-2) /
 * (i-2, j-1) for STEP_PENALTY, so the local slope stays between 1/2 and 2: a run of reference bins cannot be squeezed onto one
 * attempt bin (the plain DTW does that when every bin is equally "wrong" by a few tens of cents), and genuine tempo changes up
 * to 2x are still followed.
 *   band === null : subsequence DTW. tg is free at both ends (each skipped target bin costs SKIP_PENALTY): a partial take can sit
 *                   anywhere inside the phrase.
 *   band = b      : whole-phrase DTW. Both ends are anchored and the path stays within b (as a fraction of the phrase) of the
 *                   diagonal, which keeps a bad but complete take from being matched to the wrong half of the phrase.
 */
export function dtwCost(q: Float64Array, tg: Float64Array, band: number | null = null): number {
  const n = q.length;
  const m = tg.length;
  if (n === 0 || m === 0) return Infinity;
  const INF = 1e12;
  const inBand = (i: number, j: number): boolean => band === null || Math.abs(j / Math.max(1, m - 1) - i / Math.max(1, n - 1)) <= band;
  let r2 = new Float64Array(m).fill(INF); // row i-2
  let r1 = new Float64Array(m).fill(INF); // row i-1
  let cur = new Float64Array(m);
  for (let j = 0; j < m; j++) r1[j] = inBand(0, j) ? local(q[0], tg[j]) + (band === null ? SKIP_PENALTY * j : 0) : INF;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let best = INF;
      if (inBand(i, j)) {
        if (j >= 1 && r1[j - 1] < best) best = r1[j - 1];
        if (j >= 2 && r1[j - 2] + STEP_PENALTY < best) best = r1[j - 2] + STEP_PENALTY;
        if (i >= 2 && j >= 1 && r2[j - 1] + STEP_PENALTY < best) best = r2[j - 1] + STEP_PENALTY;
      }
      cur[j] = best >= INF ? INF : best + local(q[i], tg[j]);
    }
    const t = r2;
    r2 = r1;
    r1 = cur;
    cur = t;
  }
  let min = INF;
  for (let j = 0; j < m; j++) {
    if (band !== null && j / Math.max(1, m - 1) < 1 - band) continue;
    const c = r1[j] + (band === null ? SKIP_PENALTY * (m - 1 - j) : 0);
    if (c < min) min = c;
  }
  return min >= INF ? Infinity : min;
}

/** Same recurrence with backtracking: [queryIndex, targetIndex] pairs in order (skipped bins of a 2-step move are included). */
export function dtwPath(q: Float64Array, tg: Float64Array, band: number | null = null): [number, number][] {
  const n = q.length;
  const m = tg.length;
  const INF = 1e12;
  const inBand = (i: number, j: number): boolean => band === null || Math.abs(j / Math.max(1, m - 1) - i / Math.max(1, n - 1)) <= band;
  const D = new Float64Array(n * m).fill(INF);
  const mv = new Uint8Array(n * m); // 0 diag, 1 from (i-1, j-2), 2 from (i-2, j-1), 3 start
  for (let j = 0; j < m; j++) {
    if (!inBand(0, j)) continue;
    D[j] = local(q[0], tg[j]) + (band === null ? SKIP_PENALTY * j : 0);
    mv[j] = 3;
  }
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!inBand(i, j)) continue;
      let best = INF;
      let how = 0;
      if (j >= 1 && D[(i - 1) * m + j - 1] < best) best = D[(i - 1) * m + j - 1];
      if (j >= 2 && D[(i - 1) * m + j - 2] + STEP_PENALTY < best) { best = D[(i - 1) * m + j - 2] + STEP_PENALTY; how = 1; }
      if (i >= 2 && j >= 1 && D[(i - 2) * m + j - 1] + STEP_PENALTY < best) { best = D[(i - 2) * m + j - 1] + STEP_PENALTY; how = 2; }
      if (best < INF) {
        D[i * m + j] = best + local(q[i], tg[j]);
        mv[i * m + j] = how;
      }
    }
  }
  let j = -1;
  let bestC = INF;
  for (let k = 0; k < m; k++) {
    if (band !== null && k / Math.max(1, m - 1) < 1 - band) continue;
    const c = D[(n - 1) * m + k] + (band === null ? SKIP_PENALTY * (m - 1 - k) : 0);
    if (c < bestC) { bestC = c; j = k; }
  }
  if (j < 0) return [];
  let i = n - 1;
  const path: [number, number][] = [];
  for (;;) {
    path.push([i, j]);
    const how = mv[i * m + j];
    if (how === 3) break;
    if (how === 0) { i--; j--; }
    else if (how === 1) { path.push([i, j - 1]); i--; j -= 2; }
    else { path.push([i - 1, j]); i -= 2; j--; }
    if (i < 0 || j < 0) break;
  }
  return path.reverse();
}

function shifted(c: Contour, semis: number): Float64Array {
  return c.m.map((v) => v + semis);
}

/** DTW cost of the attempt contour against the reference moved by T semitones (the shorter contour is the query). */
function alignCost(ref: Contour, att: Contour, T: number, band: number | null = null): number {
  const r = shifted(ref, T); // reference as it should sound in the attempt's key
  return att.m.length <= r.length ? dtwCost(att.m, r, band) : dtwCost(r, att.m, band);
}

/** A take whose whole-phrase alignment costs at most this much more than the free-ends one is treated as a whole-phrase take. */
const BAND = 0.22;
const WHOLE_SLACK = 1.15;
const WHOLE_SLACK_ABS = 0.04; // per bin

/** Order-free pitch-only proposals for the key shift: the five best T by mean distance of attempt notes to the nearest shifted reference note. */
function candidateShifts(rP: number[], uP: number[]): number[] {
  if (rP.length === 0 || uP.length === 0) return [0];
  const costs: [number, number][] = [];
  for (let T = -30; T <= 30; T++) {
    let s = 0;
    for (const u of uP) {
      let best = 3;
      for (const r of rP) best = Math.min(best, Math.abs(u - r - T));
      s += best;
    }
    costs.push([s / uP.length, T]);
  }
  costs.sort((a, b) => a[0] - b[0]);
  return costs.slice(0, 5).map((c) => c[1]);
}

export interface NoteMap {
  k: number;
  /** Reference bins inside the note (indices into refC). */
  bins: number[];
  /** Share of those bins that have an attempt counterpart. */
  covered: number;
  /** Mapped attempt window: entry corner and last mapped time. NaN when not covered. */
  u0: number;
  u1: number;
  /** Median pitch error over the note's bins, cents, octave-folded, detune removed ('free'). NaN when unmatched. */
  err: number;
  /** Octaves removed by the fold (non-zero = the attempt note sits an octave away from the rest). */
  octaves: number;
  /** Reference bins of this note that have an attempt counterpart (parallel to binErr / binOct). */
  mappedBins: number[];
  /** Per-bin folded errors (cents) for the contour score. */
  binErr: number[];
  /** Per-bin octave counts (parallel to binErr). */
  binOct: number[];
  matched: boolean;
  /** Reference bins were squeezed into much less attempt time than expected: the note was not really sung. */
  collapsed: boolean;
  /** Onset is a sharp feature (after a rest or a pitch step): its attempt time is measurable. */
  transition: boolean;
  /** Attempt pitch for this note, MIDI. */
  userPitch: number;
}

export interface Alignment {
  T: number;
  /** Transposition used for the comparison (= T in 'free' key mode, T rounded to octaves in 'locked'). */
  teff: number;
  /** Constant detune (cents). Removed in 'free' mode, reported only in 'locked'. */
  keyOffset: number;
  step: number;
  refC: Contour;
  attC: Contour;
  /** Per reference bin: mapped attempt times (min, median, max), NaN when none. */
  mapMin: Float64Array;
  mapMed: Float64Array;
  mapMax: Float64Array;
  notes: NoteMap[];
  refPitch: number[];
  lag: number;
  tempo: number;
  tempoFitted: boolean;
  /** `found`: the take has a sound of its own at this entrance (a voiced-run start, or the pitch step in the right direction) near where the time model expects it. When it has not, `user` is only the warp's corner and is no evidence of timing. */
  onsetPairs: { k: number; ref: number; user: number; found: boolean }[];
  /** End of a note that is followed by a rest (or ends the phrase): end of the voiced run, reference and attempt. */
  endPairs: { k: number; ref: number; user: number }[];
  /** Mean capped semitone distance along the path, per reference bin. */
  dtwCostPerBin: number;
  /** The take was aligned as a whole phrase (anchored ends) rather than as a partial take. */
  wholePhrase: boolean;
  /** Share of aligned reference bins where the attempt, read at the RIGID model time (no warp), is within 100 cents: rhythm and melody agree. */
  rigid100: number;
  /** RMS (ms) of how far the DTW warp strays from the rigid model: a take of the same phrase stays near it, a different phrase does not. */
  warpRmsMs: number;
  at(t: number): number;
}

export function alignContours(
  ref: Prep,
  att: Prep,
  prior: { T: number } | null,
  /** `guideShift`: in 'locked' mode the singer follows a guide moved by this many semitones, so that key (and its octaves) is the right one. */
  opts: { rate: number; keyMode: 'free' | 'locked'; guideShift?: number },
): Alignment {
  const rn = ref.a.notes;
  const rP = rn.map((n) => notePitch(ref, n));
  const uP = att.a.notes.map((n) => notePitch(att, n));

  // ---- 1. key shift ---------------------------------------------------------------------------------------
  const coarse = Math.max(0.06, Math.sqrt((ref.a.voicedSec * att.a.voicedSec) / MAX_CELLS));
  const rC0 = pooled(ref, coarse);
  const aC0 = pooled(att, coarse);
  const cands = new Set<number>();
  if (prior) cands.add(prior.T);
  for (const T of candidateShifts(rP, uP)) cands.add(T);
  if (rC0.m.length && aC0.m.length) cands.add(Math.round(median(Array.from(aC0.m)) - median(Array.from(rC0.m))));
  cands.add(0);
  for (const T of Array.from(cands)) {
    cands.add(T - 12);
    cands.add(T + 12);
  }
  const norm = Math.max(1, Math.min(rC0.m.length, aC0.m.length));
  const freeCost = new Map<number, number>();
  const bandCost = new Map<number, number>();
  const costFree = (T: number): number => {
    let c = freeCost.get(T);
    if (c === undefined) freeCost.set(T, (c = alignCost(rC0, aC0, T) / norm));
    return c;
  };
  const costBand = (T: number): number => {
    let c = bandCost.get(T);
    if (c === undefined) bandCost.set(T, (c = alignCost(rC0, aC0, T, BAND) / norm));
    return c;
  };
  const list = Array.from(cands).filter((T) => Math.abs(T) <= 36);
  // whole-phrase or partial take? Decide on the best costs over all candidate shifts, then pick the shift within that hypothesis:
  // a poor take of the whole phrase cannot be told from a good partial take by the free-ends cost alone, and the free-ends
  // search then locks onto a spurious part of the phrase.
  const bestFree = Math.min(...list.map(costFree));
  const bestBand = Math.min(...list.map(costBand));
  const whole = Number.isFinite(bestBand) && bestBand <= bestFree * WHOLE_SLACK + WHOLE_SLACK_ABS;
  const costOf = whole ? costBand : costFree;
  let bestT = list[0] ?? 0;
  for (const T of list) if (costOf(T) < costOf(bestT) - 1e-9) bestT = T;
  if (prior && list.includes(prior.T) && costOf(prior.T) <= costOf(bestT) * 1.03 + 0.01) bestT = prior.T;
  for (const T of [bestT - 1, bestT + 1]) if (costOf(T) < costOf(bestT) - 0.02) bestT = T;

  // ---- 2. full alignment at the fine step, re-centred on the take's constant detune -----------------------------
  const step = Math.max(0.03, Math.sqrt((ref.a.voicedSec * att.a.voicedSec) / MAX_CELLS));
  const refC = pooled(ref, step);
  const attC = pooled(att, step);
  const nR = refC.m.length;
  const nA = attC.m.length;
  const mapMin = new Float64Array(nR).fill(NaN);
  const mapMed = new Float64Array(nR).fill(NaN);
  const mapMax = new Float64Array(nR).fill(NaN);
  const rawErr = new Float64Array(nR).fill(NaN); // cents against the integer shift T, before detune removal and octave folding
  let pathCost = 0;
  let total = bestT * 100; // best estimate of attempt minus reference, cents (integer shift + constant detune)
  let T = bestT;
  let passT = bestT; // the integer shift rawErr was last computed against (T itself is re-derived from `total` when the passes end)
  for (let pass = 0; pass < 3; pass++) {
    // The DTW runs with the constant detune already removed: without that, a take ~50 cents from every note makes every bin
    // equally "wrong" and the warp starts hunting for cheaper-looking matches. The integer shift is re-derived each pass so
    // the detune stays within +-50 cents (a poor take can sit a whole semitone from the first guess).
    T = Math.round(total / 100) || 0; // `|| 0` turns -0 into 0
    passT = T;
    mapMin.fill(NaN);
    mapMed.fill(NaN);
    mapMax.fill(NaN);
    rawErr.fill(NaN);
    pathCost = 0;
    if (nR >= 3 && nA >= 3) {
      const rs = shifted(refC, total / 100);
      const userIsQuery = nA <= nR;
      const path = userIsQuery ? dtwPath(attC.m, rs, whole ? BAND : null) : dtwPath(rs, attC.m, whole ? BAND : null);
      const idx: number[][] = Array.from({ length: nR }, () => []);
      for (const [qi, ti] of path) {
        if (userIsQuery) idx[ti].push(qi);
        else idx[qi].push(ti);
      }
      for (let i = 0; i < nR; i++) {
        const js = idx[i];
        if (js.length === 0) continue;
        const times = js.map((j) => attC.t[j]);
        mapMin[i] = Math.min(...times);
        mapMax[i] = Math.max(...times);
        mapMed[i] = median(times);
        rawErr[i] = median(js.map((j) => (attC.m[j] - refC.m[i] - T) * 100));
        pathCost += Math.min(COST_CAP, Math.abs(rawErr[i] / 100));
      }
    }
    const ds: number[] = [];
    for (let i = 0; i < nR; i++) if (Number.isFinite(rawErr[i])) ds.push(foldOctave(rawErr[i]).folded);
    if (ds.length < 5) break;
    const next = T * 100 + median(ds);
    const moved = Math.abs(next - total);
    total = next;
    if (moved < 8) {
      T = Math.round(total / 100) || 0;
      break;
    }
  }
  // the last pass may have ended with a different rounding of `total` than the one its errors were measured against
  if (passT !== T) for (let i = 0; i < nR; i++) if (Number.isFinite(rawErr[i])) rawErr[i] += (passT - T) * 100;
  // A poor take's notes scatter by tens of cents, so "a semitone lower" and "a little flat all the way through" cannot be told apart, and
  // the constant detune happily absorbs either. Calling it a transposition is a claim ("you sang this 1 semitone lower, a different key
  // is fine") that only holds when the take is also tidy in the shifted key; otherwise it is read in the nearest octave multiple.
  let looseKey = false;
  if (opts.keyMode === 'free' && T % 12 !== 0) {
    const Tn = 12 * Math.round(T / 12) || 0;
    if (Math.abs(T - Tn) <= KEY_SNAP_MAX_SEMITONES) {
      const ds: number[] = [];
      for (let i = 0; i < nR; i++) if (Number.isFinite(rawErr[i])) ds.push(foldOctave(rawErr[i]).folded);
      if (ds.length >= 5) {
        const off = median(ds);
        if (ds.filter((d) => Math.abs(d - off) <= KEY_TIDY_CENTS).length / ds.length < KEY_TIDY_SHARE) {
          for (let i = 0; i < nR; i++) if (Number.isFinite(rawErr[i])) rawErr[i] += (T - Tn) * 100;
          T = Tn;
          looseKey = true;
        }
      }
    }
  }
  const guide = Number.isFinite(opts.guideShift) ? Math.round(opts.guideShift as number) : 0;
  const teff = opts.keyMode === 'free' ? T : guide + 12 * Math.round((T - guide) / 12) || 0;
  // errors against the integer shift actually used for scoring (rawErr was computed against T of the last pass)
  if (teff !== T) for (let i = 0; i < nR; i++) if (Number.isFinite(rawErr[i])) rawErr[i] += (T - teff) * 100;
  const plausible: number[] = [];
  for (let i = 0; i < nR; i++) {
    if (!Number.isFinite(rawErr[i])) continue;
    const f = foldOctave(rawErr[i]).folded;
    if (Math.abs(f) < (looseKey ? 250 : 100)) plausible.push(f);
  }
  const keyOffset = plausible.length ? median(plausible) : 0;
  const delta = opts.keyMode === 'free' ? keyOffset : 0;

  // ---- 3. per reference note ------------------------------------------------------------------------------
  const notes: NoteMap[] = rn.map((r, k) => {
    const lo = r.start + 0.5 * step;
    const hi = r.end - 0.5 * step;
    const bins: number[] = [];
    for (let i = 0; i < nR; i++) if (refC.t[i] >= lo && refC.t[i] <= hi) bins.push(i);
    const mapped = bins.filter((i) => Number.isFinite(rawErr[i]));
    const folds = mapped.map((i) => foldOctave(rawErr[i] - delta));
    const prevEnd = k > 0 ? rn[k - 1].end : -Infinity;
    const jump = k > 0 ? Math.abs(rP[k] - rP[k - 1]) : 0;
    return {
      k, bins, mappedBins: mapped,
      covered: bins.length ? mapped.length / bins.length : 0,
      u0: mapped.length ? Math.min(...mapped.map((i) => mapMin[i])) : NaN,
      u1: mapped.length ? Math.max(...mapped.map((i) => mapMax[i])) : NaN,
      err: folds.length ? median(folds.map((f) => f.folded)) : NaN,
      octaves: folds.length ? Math.round(median(folds.map((f) => f.octaves))) : 0,
      binErr: folds.map((f) => f.folded),
      binOct: folds.map((f) => f.octaves),
      matched: bins.length >= 2 && mapped.length / bins.length >= 0.3 && mapped.length >= 3,
      collapsed: false,
      transition: k === 0 || r.start - prevEnd >= 0.08 || jump >= 0.8,
      userPitch: NaN,
    };
  });

  // ---- 4. transition times (segmentation- and pitch-error-independent), then the rigid time model ------------
  // Stage 1 reads the attempt's transitions near the DTW corners; the rigid model is fitted to them; stage 2 re-reads each
  // transition near the MODEL's prediction (so a DTW corner that was dragged by a pitch error cannot mislead) and refits.
  const refRuns = voicedRuns(ref);
  const attRuns = voicedRuns(att);
  interface Tr { k: number; kind: 'gap' | 'step'; dir: number; ref: number; user: number; dtw: number; found: boolean }
  const trs: Tr[] = [];
  const ends: { k: number; ref: number; user: number; dtw: number }[] = [];
  for (const nm of notes) {
    if (!nm.matched) continue;
    const k = nm.k;
    const r = rn[k];
    const first = nm.bins.find((i) => Number.isFinite(mapMin[i]));
    if (first === undefined) continue;
    const dtw = mapMin[first] - 0.5 * step; // DTW corner: only a first guess
    const prevEnd = k > 0 ? rn[k - 1].end : -Infinity;
    if (r.end - r.start >= 0.12 && nm.transition) {
      if (k === 0 || r.start - prevEnd >= 0.08) {
        const tr = nearest(refRuns.starts, r.start, 0.3) ?? r.start;
        const tu = nearest(attRuns.starts, dtw - (r.start - tr), 0.4);
        trs.push({ k, kind: 'gap', dir: 0, ref: tr, user: tu ?? dtw, dtw, found: tu !== null });
      } else {
        const dir = Math.sign(rP[k] - rP[k - 1]);
        const tr = stepTime(ref, r.start, 0.15, dir);
        const tu = stepTime(att, dtw, 0.25, dir);
        if (tr !== null && tu !== null) trs.push({ k, kind: 'step', dir, ref: tr, user: tu, dtw, found: true });
        else trs.push({ k, kind: 'step', dir, ref: r.start, user: dtw, dtw, found: false });
      }
    }
    const last = k === rn.length - 1;
    if (last || rn[k + 1].start - r.end >= 0.08) {
      const lastBin = [...nm.bins].reverse().find((i) => Number.isFinite(mapMax[i]));
      if (lastBin !== undefined) {
        const tr = nearest(refRuns.ends, r.end, 0.3) ?? r.end;
        const dtwEnd = mapMax[lastBin] + 0.5 * step;
        ends.push({ k, ref: tr, user: nearest(attRuns.ends, dtwEnd, 0.4) ?? dtwEnd, dtw: dtwEnd });
      }
    }
  }
  const nominal = 1 / opts.rate;
  let lag = 0;
  let tempo = nominal;
  let tempoFitted = false;
  const fitModel = (): void => {
    if (trs.length >= MIN_PAIRS_FOR_TEMPO && trs[trs.length - 1].ref - trs[0].ref >= MIN_SPAN_FOR_TEMPO_SEC) {
      const f = theilSen(trs.map((p) => p.ref), trs.map((p) => p.user));
      tempo = Math.min(1.8 * nominal, Math.max(0.55 * nominal, f.slope));
      lag = median(trs.map((p) => p.user - tempo * p.ref));
      tempoFitted = true;
    } else if (trs.length >= 1) {
      tempo = nominal;
      lag = median(trs.map((p) => p.user - nominal * p.ref));
      tempoFitted = false;
    }
  };
  fitModel();
  // a note whose DTW window is far shorter than it should take at this tempo was squeezed in by the warp: it was not sung. Its
  // transitions are not evidence of anything, so they leave the model.
  for (const nm of notes) {
    if (!nm.matched) continue;
    const expect = tempo * (rn[nm.k].end - rn[nm.k].start);
    nm.collapsed = expect > 0.25 && nm.u1 - nm.u0 < 0.3 * expect;
    if (nm.collapsed) nm.matched = false;
  }
  if (notes.some((n) => n.collapsed)) {
    const dead = new Set(notes.filter((n) => n.collapsed).map((n) => n.k));
    for (let i = trs.length - 1; i >= 0; i--) if (dead.has(trs[i].k)) trs.splice(i, 1);
    for (let i = ends.length - 1; i >= 0; i--) if (dead.has(ends[i].k)) ends.splice(i, 1);
    fitModel();
  }
  for (let stage = 0; stage < 2; stage++) {
    for (const t of trs) {
      const pred = lag + tempo * t.ref;
      if (t.kind === 'gap') {
        const tu = nearest(attRuns.starts, pred, 0.35);
        if (tu !== null) t.user = tu;
        t.found = tu !== null;
      } else {
        // the pitch step in the right direction, or (the singer breathed or cut the note short where the original runs on) the start of a voiced run
        const tu = stepTime(att, pred, 0.2, t.dir) ?? nearest(attRuns.starts, pred, 0.2);
        if (tu !== null) t.user = tu;
        t.found = tu !== null;
      }
    }
    for (const e of ends) {
      const tu = nearest(attRuns.ends, lag + tempo * e.ref, 0.45);
      if (tu !== null) e.user = tu;
    }
    fitModel();
  }
  const onsetPairs = trs.map((t) => ({ k: t.k, ref: t.ref, user: t.user, found: t.found }));
  const endPairs = ends.map((e) => ({ k: e.k, ref: e.ref, user: e.user }));
  // refined mapped windows: from the note's start transition to its end transition (or the next note's start)
  const startAt = new Map(onsetPairs.map((p) => [p.k, p.user]));
  const endAt = new Map(endPairs.map((p) => [p.k, p.user]));
  for (const nm of notes) {
    if (!nm.matched) continue;
    const u0 = startAt.get(nm.k) ?? nm.u0;
    let u1 = endAt.get(nm.k) ?? (nm.k + 1 < rn.length && rn[nm.k + 1].start - rn[nm.k].end < 0.08 ? startAt.get(nm.k + 1) : undefined) ?? nm.u1;
    if (!(u1 > u0 + 0.05)) u1 = nm.u1;
    if (u1 > u0 + 0.05) {
      nm.u0 = u0;
      nm.u1 = u1;
    }
  }
  // attempt pitch per note: median of the attempt's centre line over the middle of its mapped window
  for (const nm of notes) {
    if (!nm.matched) continue;
    const d = nm.u1 - nm.u0;
    const i0 = Math.max(0, Math.round((nm.u0 + 0.2 * d) / att.hop));
    const i1 = Math.min(att.centre.length, Math.round((nm.u1 - 0.2 * d) / att.hop));
    const vals: number[] = [];
    for (let i = i0; i < i1; i++) if (Number.isFinite(att.centre[i])) vals.push(att.centre[i]);
    nm.userPitch = vals.length >= 3 ? median(vals) : NaN;
  }
  const L = lag;
  const Tm = tempo;
  // ---- 5. a second reading of each sustained note's pitch, where the time model says it was sung ---------------------------
  // The warp is free to slide along a note that moves (a fall, a scoop): 50 cents sharp on a note that falls 250 cents reads as
  // "right" when the attempt is lined up a few tens of ms later. For a note whose mapped window agrees with the time model, the
  // flat middle of the reference note is read again at the model time, with no warp, and the larger of the two errors stands
  // (never the smaller: the warp's reading is the lenient one). Notes whose timing is off keep the warp's reading.
  for (const nm of notes) {
    if (!nm.matched || !Number.isFinite(nm.err) || nm.mappedBins.length === 0) continue;
    const r = rn[nm.k];
    if (Math.abs(nm.u0 - (L + Tm * r.start)) > RIGID_START_TOL || Math.abs(nm.u1 - (L + Tm * r.end)) > RIGID_END_TOL) continue;
    const dur = r.end - r.start;
    const read: number[] = [];
    nm.mappedBins.forEach((i, n) => {
      const t = refC.t[i];
      if (t < r.start + RIGID_TRIM * dur || t > r.end - RIGID_TRIM * dur) return;
      const lo = refC.m[Math.max(0, i - 1)];
      const hi = refC.m[Math.min(nR - 1, i + 1)];
      if (Math.abs(hi - lo) > RIGID_STABLE_ST) return;
      const x = (L + Tm * t) / att.hop;
      const j = Math.floor(x);
      const a0 = att.centre[j];
      const a1 = att.centre[j + 1];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) return;
      const e = foldOctave((a0 + (a1 - a0) * (x - j) - refC.m[i] - teff) * 100 - delta).folded;
      if (Math.abs(e - nm.binErr[n]) > RIGID_AGREE_CENTS) return;
      read.push(e);
      if (Math.abs(e) > Math.abs(nm.binErr[n])) nm.binErr[n] = e;
    });
    if (read.length < RIGID_MIN_BINS) continue;
    const e = median(read);
    if (Math.abs(e - nm.err) <= RIGID_AGREE_CENTS && Math.abs(e) > Math.abs(nm.err)) nm.err = e;
  }
  // agreement with the rigid model: is this the same phrase at roughly the same pace?
  let rigidN = 0;
  let rigidOk = 0;
  let warpSq = 0;
  let warpN = 0;
  for (let i = 0; i < nR; i++) {
    if (!Number.isFinite(mapMed[i])) continue;
    const pred = L + Tm * refC.t[i];
    warpSq += (mapMed[i] - pred) ** 2;
    warpN++;
    const x = pred / att.hop;
    const j = Math.floor(x);
    const a0 = att.centre[j];
    const a1 = att.centre[j + 1];
    if (!Number.isFinite(a0) || !Number.isFinite(a1)) {
      rigidN++;
      continue;
    }
    rigidN++;
    const u = a0 + (a1 - a0) * (x - j);
    const e = foldOctave((u - refC.m[i] - teff) * 100 - delta).folded;
    if (Math.abs(e) <= 100) rigidOk++;
  }
  return { T, teff, keyOffset, step, refC, attC, mapMin, mapMed, mapMax, notes, refPitch: rP, lag, tempo, tempoFitted, onsetPairs, endPairs, dtwCostPerBin: nR ? pathCost / nR : 0, wholePhrase: whole, rigid100: rigidN ? rigidOk / rigidN : 0, warpRmsMs: warpN ? 1000 * Math.sqrt(warpSq / warpN) : 0, at: (t) => L + Tm * t };
}
