// Routing between the solo analysis and the full-song (mix) analysis, with one progress stream.
//
//   'auto'  run the solo analysis (cheap, and it is what finds out whether the audio is a song); if it raises the
//           'accompaniment' issue, run the same audio again in mix mode and return that. The solo result is kept in
//           `solo` so a caller can still show why the song was routed.
//   'solo'  the normal analysis only.
//   'mix'   the manual "full song" choice: mix mode only, no solo pass (for songs the solo check misses: about one
//           mix in five, mostly vocal-forward and EDM mixes).
//
// The analyzer is passed in (analyzeInWorker in the app, a fake in tests), so this module has no worker or DOM imports.

import type { AnalysisOptions, VoiceAnalysis } from '../types';
import { suggestsFullSong } from './quality';

export type AnalysisRouting = 'auto' | 'solo' | 'mix';

export type AnalyzeFn = (samples: Float32Array, sampleRate: number, opts: AnalysisOptions, onProgress?: (fraction: number) => void) => Promise<VoiceAnalysis>;

export interface AutoAnalysis {
  /** The analysis to use. */
  analysis: VoiceAnalysis;
  /** 'solo': normal analysis; 'mix-auto': the solo pass found a song and it was re-run in mix mode; 'mix-manual': mix mode was asked for. */
  route: 'solo' | 'mix-auto' | 'mix-manual';
  /** The solo pass when one ran ('solo' and 'mix-auto'), else null. */
  solo: VoiceAnalysis | null;
  /** Why the automatic mix pass was dropped (the solo analysis is returned instead), else null. */
  mixError: string | null;
}

/**
 * Share of the progress bar for the solo pass when a mix pass may follow. On the same 4-minute song the solo pass took
 * 4.0 s and the mix pass 2.7 s (Node, one core), so 0.6 / 0.4 would be exact; the mix pass is the one that grows on a slow
 * phone (it holds the most memory), so it gets the larger remainder.
 */
export const SOLO_PROGRESS_SHARE = 0.55;

/** Passes only increasing, finite values in 0..1 on to `cb`. */
function monotone(cb: ((fraction: number) => void) | undefined): (fraction: number) => void {
  let last = -1;
  return (f) => {
    if (!cb || !Number.isFinite(f)) return;
    const v = Math.min(1, Math.max(0, f));
    if (v <= last) return;
    last = v;
    cb(v);
  };
}

/** A callback for one pass: its 0..1 is mapped onto [from, to] of the overall stream. */
function slice(report: (fraction: number) => void, from: number, to: number): (fraction: number) => void {
  return (f) => report(from + (to - from) * Math.min(1, Math.max(0, f)));
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/**
 * Analyses `samples` with `analyze` according to `routing` (default: 'mix' when `opts.mode === 'mix'`, else 'auto').
 * `onProgress` receives one increasing stream from 0 to 1 over both passes. A failing solo pass rejects; a failing
 * automatic mix pass falls back to the solo result (`mixError` says why) so the user is never left with nothing; a failing
 * manual mix pass rejects.
 */
export async function analyzeWithRouting(
  analyze: AnalyzeFn,
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  routing: AnalysisRouting = opts.mode === 'mix' ? 'mix' : 'auto',
  onProgress?: (fraction: number) => void,
): Promise<AutoAnalysis> {
  const report = monotone(onProgress);
  const soloOpts: AnalysisOptions = { ...opts, mode: 'solo' };
  const mixOpts: AnalysisOptions = { ...opts, mode: 'mix' };
  if (routing === 'mix') {
    const analysis = await analyze(samples, sampleRate, mixOpts, slice(report, 0, 1));
    report(1);
    return { analysis, route: 'mix-manual', solo: null, mixError: null };
  }
  if (routing === 'solo') {
    const analysis = await analyze(samples, sampleRate, soloOpts, slice(report, 0, 1));
    report(1);
    return { analysis, route: 'solo', solo: analysis, mixError: null };
  }
  const solo = await analyze(samples, sampleRate, soloOpts, slice(report, 0, SOLO_PROGRESS_SHARE));
  if (!suggestsFullSong(solo)) {
    report(1);
    return { analysis: solo, route: 'solo', solo, mixError: null };
  }
  try {
    const mix = await analyze(samples, sampleRate, mixOpts, slice(report, SOLO_PROGRESS_SHARE, 1));
    report(1);
    return { analysis: mix, route: 'mix-auto', solo, mixError: null };
  } catch (err) {
    report(1);
    return { analysis: solo, route: 'solo', solo, mixError: messageOf(err) };
  }
}
