// Monotone DP alignment of sung notes to the expected pitches, tolerant of an extra or a missing note, with a whole-take
// octave offset and single-note octave slips (folded and flagged).

import type { SungNote } from '../types';
import {
  ALIGN_EXTRA_COST,
  ALIGN_MATCH_CAP_CENTS,
  ALIGN_MISSING_COST,
  ALIGN_OCTAVE_SLIP_COST,
  ALIGN_SHORT_EXTRA_COST,
  ALIGN_SHORT_EXTRA_SEC,
  OCTAVE_OFFSETS,
} from './constants';
import { foldCents } from './frames';

export interface Alignment {
  /** For each expected note, the index of the sung note matched to it, or null (missing). */
  match: (number | null)[];
  /** Indices of sung notes matched to nothing. */
  extras: number[];
}

/** Cost of matching a sung pitch to an expected one, `octaveOffset` octaves away being the norm for this take. */
export function matchCost(sungMidi: number, expectedMidi: number, octaveOffset: number): number {
  const c = (sungMidi - expectedMidi - 12 * octaveOffset) * 100;
  if (Math.abs(c) > 600) return Math.min(Math.abs(foldCents(c)), ALIGN_MATCH_CAP_CENTS) / 100 + ALIGN_OCTAVE_SLIP_COST;
  return Math.min(Math.abs(c), ALIGN_MATCH_CAP_CENTS) / 100;
}

function extraCost(n: SungNote): number {
  return n.endSec - n.startSec < ALIGN_SHORT_EXTRA_SEC ? ALIGN_SHORT_EXTRA_COST : ALIGN_EXTRA_COST;
}

/** Alignment plus its total cost (internal: the scorers pick the octave offset with the lowest cost). */
export function alignWithCost(expectedMidis: readonly number[], sung: readonly SungNote[], octaveOffset: number): Alignment & { cost: number } {
  const n = expectedMidis.length;
  const m = sung.length;
  const cost = new Float64Array((n + 1) * (m + 1));
  // 0 = match, 1 = missing (expected skipped), 2 = extra (sung skipped)
  const step = new Uint8Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    cost[at(i, 0)] = cost[at(i - 1, 0)] + ALIGN_MISSING_COST;
    step[at(i, 0)] = 1;
  }
  for (let j = 1; j <= m; j++) {
    cost[at(0, j)] = cost[at(0, j - 1)] + extraCost(sung[j - 1]);
    step[at(0, j)] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cm = cost[at(i - 1, j - 1)] + matchCost(sung[j - 1].midi, expectedMidis[i - 1], octaveOffset);
      const cd = cost[at(i - 1, j)] + ALIGN_MISSING_COST;
      const ce = cost[at(i, j - 1)] + extraCost(sung[j - 1]);
      // Ties prefer a match, then a missing note over an extra one.
      let best = cm;
      let s = 0;
      if (cd < best - 1e-9) {
        best = cd;
        s = 1;
      }
      if (ce < best - 1e-9) {
        best = ce;
        s = 2;
      }
      cost[at(i, j)] = best;
      step[at(i, j)] = s;
    }
  }
  const match: (number | null)[] = new Array(n).fill(null);
  const extras: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const s = step[at(i, j)];
    if (i > 0 && j > 0 && s === 0) {
      match[i - 1] = j - 1;
      i--;
      j--;
    } else if (i > 0 && (j === 0 || s === 1)) {
      i--;
    } else {
      extras.push(j - 1);
      j--;
    }
  }
  extras.reverse();
  return { match, extras, cost: cost[at(n, m)] };
}

/**
 * Aligns sung notes (time order) to expected MIDI pitches with a given whole-take octave offset (sung = expected +
 * 12 * offset). Match cost min(|cents|, 400) / 100 (+1 for a single-note octave slip, judged folded), missing 2.5,
 * extra 1.5 (0.5 under 200 ms).
 */
export function alignNotes(expectedMidis: number[], sung: SungNote[], octaveOffset: number): { match: (number | null)[]; extras: number[] } {
  const { match, extras } = alignWithCost(expectedMidis, sung, octaveOffset);
  return { match, extras };
}

/** The whole-take octave offset (-2..2) with the cheapest alignment; ties prefer 0, then the smaller shift. */
export function bestOctaveAlignment(expectedMidis: readonly number[], sung: readonly SungNote[]): Alignment & { cost: number; octaveOffset: number } {
  let best: (Alignment & { cost: number; octaveOffset: number }) | null = null;
  for (const k of OCTAVE_OFFSETS) {
    const a = alignWithCost(expectedMidis, sung, k);
    if (!best || a.cost < best.cost - 1e-9) best = { ...a, octaveOffset: k };
  }
  return best!;
}
