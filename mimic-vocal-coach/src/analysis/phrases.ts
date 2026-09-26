// Phrases: stretches of voiced activity separated by real pauses (breaths), not by consonants.

import type { FrameFeatures, Phrase } from '../types';

/** A phrase plus the frame range it covers ([i0, i1), i0 = first voiced frame, i1 - 1 = last). */
export interface PhraseSpan extends Phrase {
  i0: number;
  i1: number;
}

/** Unvoiced gaps shorter than this are consonants or glottal stops inside a phrase. */
export const PHRASE_MERGE_GAP_SEC = 0.25;
/** Shorter phrases are too brief to be sung phrases (clicks, stray voiced noise). */
export const PHRASE_MIN_SEC = 0.2;

/** Voiced runs as [start, end) frame ranges. */
export function voicedRuns(frames: FrameFeatures[]): [number, number][] {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < frames.length) {
    if (!frames[i].voiced) {
      i++;
      continue;
    }
    let j = i;
    while (j < frames.length && frames[j].voiced) j++;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

export function findPhrases(frames: FrameFeatures[], hopSec: number): PhraseSpan[] {
  const runs = voicedRuns(frames);
  const merged: [number, number][] = [];
  const maxGap = Math.round(PHRASE_MERGE_GAP_SEC / hopSec);
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] < maxGap) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  const minFrames = Math.round(PHRASE_MIN_SEC / hopSec);
  return merged
    .filter(([a, b]) => b - a >= minFrames)
    .map(([a, b]) => ({ start: frames[a].t, end: frames[b - 1].t + hopSec, i0: a, i1: b }));
}
