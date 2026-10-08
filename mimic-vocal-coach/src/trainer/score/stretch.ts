// Time-scaling of an analysis: what the reference looks like when it is played slowed down.
//
// A take that follows a guide played at 0.5x runs about twice as long as the reference. The aligner is slope-limited around
// "attempt time = reference time", so the reference is laid out at the speed that was played (frames repeated, every time
// stretched) and compared at tempo 1: the expected path is then the diagonal and a perfect slow copy is an ordinary perfect
// copy. The scorer keeps reporting note windows and entrances in the ORIGINAL reference time; only the alignment sees this copy.

import type { VoiceAnalysis } from '../../types';

/** Below this distance from 1 the reference is used as it is (a stretch of 1 % cannot matter to the aligner). */
const NEGLIGIBLE = 0.02;

/** The analysis with its time axis multiplied by `f` (f > 1 = slower). Pitch, tone and level values are untouched. */
export function stretchAnalysis(a: VoiceAnalysis, f: number): VoiceAnalysis {
  if (!(f > 0) || Math.abs(f - 1) < NEGLIGIBLE) return a;
  const n = a.frames.length;
  const hop = a.hopSec;
  const frames = Array.from({ length: Math.round(n * f) }, (_, j) => {
    const i = Math.min(n - 1, Math.round(j / f));
    return { ...a.frames[i], t: j * hop + (a.frames[i].t - i * hop) };
  });
  return {
    ...a,
    durationSec: a.durationSec * f,
    voicedSec: a.voicedSec * f,
    frames,
    notes: a.notes.map((x) => ({ ...x, start: x.start * f, end: x.end * f })),
    phrases: a.phrases.map((p) => ({ ...p, start: p.start * f, end: p.end * f })),
    onsets: a.onsets.map((o) => ({ ...o, t: o.t * f })),
    runs: a.runs.map((r) => ({ ...r, start: r.start * f, end: r.end * f, notesPerSec: r.notesPerSec / f })),
  };
}
