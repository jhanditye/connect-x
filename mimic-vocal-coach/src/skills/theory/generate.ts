// Seeded, pure generators for every exercise's targets. Same rng seed -> same targets (tests pass ?seed=N).

import type { Degree, EarQuestion, IntervalDirection, IntervalTarget, MusicalKey, RegisterThird, ScaleMode, SeqNote, SequencePreset, SungDirection, VoiceRange, WrittenDegree } from '../types';
import { cleanIntervalSet, intervalTargetMidi } from './intervals';
import { DEGREES, SCALE_STEPS } from './scales';
import { placeDegrees } from './sequence';
import { candidateTonics, registerBands } from './range';
import { pick, randInt, rngId, shuffle, weightedIndex, type Rng } from './rng';

// ---------------------------------------------------------------------------------------------
// Single notes (pitch test, match the note)

/** How many of `count` notes go to each third: 10 -> low 3, mid 4, high 3. */
export function registerCounts(count: number): Record<RegisterThird, number> {
  const n = Math.max(0, Math.round(count));
  const low = Math.floor(n / 3);
  const high = Math.floor(n / 3);
  return { low, mid: n - low - high, high };
}

/**
 * `count` single target notes spread over the low, middle and high thirds of the range, in random order, with no
 * note repeated back to back and as few repeats overall as the range allows. Every note is inside the range.
 */
export function singleNoteTargets(range: VoiceRange, count: number, rng: Rng): { midi: number; register: RegisterThird }[] {
  const bands = registerBands(range);
  const counts = registerCounts(count);
  const out: { midi: number; register: RegisterThird }[] = [];
  for (const reg of ['low', 'mid', 'high'] as RegisterThird[]) {
    const band = bands[reg];
    const pool: number[] = [];
    for (let m = band.lowMidi; m <= band.highMidi; m++) pool.push(m);
    let bag = shuffle(rng, pool);
    for (let i = 0; i < counts[reg]; i++) {
      if (bag.length === 0) bag = shuffle(rng, pool);
      out.push({ midi: bag.pop() as number, register: reg });
    }
  }
  const order = shuffle(rng, out);
  // No identical notes back to back (swap forward when it happens).
  for (let i = 1; i < order.length; i++) {
    if (order[i].midi !== order[i - 1].midi) continue;
    const j = order.findIndex((x, k) => k > i && x.midi !== order[i - 1].midi && (k + 1 >= order.length || order[k + 1].midi !== order[i].midi));
    if (j > i) [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// Intervals

/** First note so that both notes lie inside the range (1 semitone margin when possible); null when it cannot fit. */
export function intervalStartMidi(semitones: number, direction: IntervalDirection | SungDirection, range: VoiceRange, rng: Rng): number | null {
  const s = Math.abs(Math.round(semitones));
  const offsets = direction === 'down' ? [0, -s] : [0, s];
  const cands = candidateTonics(offsets, range, 1);
  if (cands.length === 0) return null;
  // Any start that fits, not just the central ones: intervals should be heard all over the range.
  return pick(rng, cands);
}

/**
 * One ear-training interval question. `weights` (same order as the cleaned set) bias the choice towards weak
 * intervals; the direction is picked from `directions` (default melodic up and down).
 */
export function intervalQuestion(
  rng: Rng,
  set: readonly number[],
  range: VoiceRange,
  opts: { directions?: readonly IntervalDirection[]; weights?: readonly number[] } = {},
): EarQuestion {
  const choices = cleanIntervalSet(set);
  const dirs = opts.directions && opts.directions.length > 0 ? opts.directions : (['up', 'down'] as IntervalDirection[]);
  const idx = opts.weights && opts.weights.length === choices.length ? weightedIndex(rng, opts.weights) : randInt(rng, 0, choices.length - 1);
  const semitones = choices[idx];
  const direction = pick(rng, dirs);
  const start = intervalStartMidi(semitones, direction, range, rng) ?? Math.round((range.lowMidi + range.highMidi) / 2);
  return { kind: 'interval', id: rngId(rng), firstMidi: start, semitones, direction, choices };
}

/** A sung-interval drill item: reference note plus interval and direction, both notes inside the range. */
export function singIntervalTarget(rng: Rng, set: readonly number[], range: VoiceRange, opts: { directions?: readonly SungDirection[]; weights?: readonly number[] } = {}): IntervalTarget {
  const choices = cleanIntervalSet(set).filter((s) => s > 0);
  const pool = choices.length > 0 ? choices : [7];
  const dirs = opts.directions && opts.directions.length > 0 ? opts.directions : (['up', 'down'] as SungDirection[]);
  const idx = opts.weights && opts.weights.length === pool.length ? weightedIndex(rng, opts.weights) : randInt(rng, 0, pool.length - 1);
  const semitones = pool[idx];
  const direction = pick(rng, dirs);
  const referenceMidi = intervalStartMidi(semitones, direction, range, rng) ?? Math.round((range.lowMidi + range.highMidi) / 2);
  return { referenceMidi, semitones, direction };
}

/** The second note of a sung-interval target. */
export function intervalTargetOf(t: IntervalTarget): number {
  return intervalTargetMidi(t.referenceMidi, t.semitones, t.direction);
}

// ---------------------------------------------------------------------------------------------
// Hear the degree

/**
 * A "hear the degree" question: a key whose tonic and the played degree (in the octave above the tonic) both sit in
 * the range. `weights` index degrees 1..7 (array of 7).
 */
export function degreeQuestion(rng: Rng, mode: ScaleMode, range: VoiceRange, weights?: readonly number[]): EarQuestion {
  const di = weights && weights.length === 7 ? weightedIndex(rng, weights) : randInt(rng, 0, 6);
  const degree = DEGREES[di];
  const step = SCALE_STEPS[mode][di];
  // The cadence and tonic should sit comfortably too: fit tonic..tonic+11.
  const cands = candidateTonics([0, step, 7], range, 1);
  const tonic = cands.length > 0 ? pick(rng, cands.slice(0, 5)) : range.lowMidi;
  const key: MusicalKey = { tonicMidi: tonic, mode };
  return { kind: 'degree', id: rngId(rng), key, degree, midi: tonic + step, choices: DEGREES.slice() };
}

// ---------------------------------------------------------------------------------------------
// Scale-degree lines

/** The presets the Sequence screen offers (the singer's own examples first). */
export const SEQUENCE_PRESETS: readonly SequencePreset[] = Object.freeze([
  { id: 'down-7-to-2', label: 'Down from 7', text: '7 6 5 4 3 2' },
  { id: 'leap-2-7-6-5', label: 'Leap: 2 down to 7', text: '2 7 6 5' },
  { id: 'down-from-8', label: 'Down from 8', text: '8 7 6 5 4 3 2 1' },
  { id: 'up-1-to-8', label: 'Up the scale', text: '1 2 3 4 5 6 7 8' },
  { id: 'five-down', label: '5 down to 1', text: '5 4 3 2 1' },
  { id: 'arpeggio', label: 'Arpeggio', text: '1 3 5 3 1' },
  { id: 'arpeggio-octave', label: 'Arpeggio to 8', text: '1 3 5 8 5 3 1' },
  { id: 'turn', label: 'Turn around 1', text: '1 7- 1 2 1' },
] as SequencePreset[]);

/** Written degrees stepping from one degree to another (inclusive): stepwise(7, 2) -> [7, 6, 5, 4, 3, 2]. */
export function stepwise(from: WrittenDegree, to: WrittenDegree): WrittenDegree[] {
  const out: WrittenDegree[] = [];
  const dir = to >= from ? 1 : -1;
  for (let d: number = from; dir > 0 ? d <= to : d >= to; d += dir) out.push(d as WrittenDegree);
  return out;
}

/** Notes (placed in the mode) for written degrees with no octave marks. */
export function lineFromDegrees(degrees: readonly WrittenDegree[], mode: ScaleMode): SeqNote[] {
  return placeDegrees(
    degrees.map((written) => ({ written, marks: null })),
    mode,
  );
}

/**
 * A random line of `length` notes (clamped 2..12), biased towards weak degrees. `degreeWeights[d-1]` is the weakness
 * weight of degree d (default 1 each). Starts on 1, 3 or 5 so the key is easy to hear; never repeats a degree back to
 * back; leaps are at most `maxLeap` semitones (default 7, a 5th); the whole line spans at most `maxSpan` (default 12).
 */
export function randomLine(
  rng: Rng,
  length: number,
  mode: ScaleMode,
  opts: { degreeWeights?: readonly number[]; maxLeap?: number; maxSpan?: number } = {},
): SeqNote[] {
  const n = Math.max(2, Math.min(12, Math.round(length)));
  const maxLeap = opts.maxLeap ?? 7;
  const maxSpan = opts.maxSpan ?? 12;
  const w = opts.degreeWeights && opts.degreeWeights.length === 7 ? opts.degreeWeights : [1, 1, 1, 1, 1, 1, 1];
  for (let attempt = 0; attempt < 50; attempt++) {
    const degrees: WrittenDegree[] = [pick(rng, [1, 3, 5] as Degree[])];
    let ok = true;
    for (let i = 1; i < n && ok; i++) {
      const prev = degrees[i - 1];
      const options = DEGREES.filter((d) => d !== (prev === 8 ? 1 : prev));
      const weights = options.map((d) => w[d - 1]);
      let placed = false;
      for (let tries = 0; tries < 12 && !placed; tries++) {
        const d = options[weightedIndex(rng, weights)];
        const trial = lineFromDegrees([...degrees, d], mode);
        const last = trial[trial.length - 1].semitones;
        const before = trial[trial.length - 2].semitones;
        const span = Math.max(...trial.map((x) => x.semitones)) - Math.min(...trial.map((x) => x.semitones));
        if (Math.abs(last - before) <= maxLeap && span <= maxSpan) {
          degrees.push(d);
          placed = true;
        }
      }
      ok = placed;
    }
    if (ok) return lineFromDegrees(degrees, mode);
  }
  // Fallback that always satisfies the rules: steps down from 5 to 1 and back up, as long as needed.
  const cycle: WrittenDegree[] = [5, 4, 3, 2, 1, 2, 3, 4];
  return lineFromDegrees(Array.from({ length: n }, (_, i) => cycle[i % cycle.length]), mode);
}

/** Random line length for the "Mixed" preset: 4..8. */
export function mixedLength(rng: Rng): number {
  return randInt(rng, 4, 8);
}
