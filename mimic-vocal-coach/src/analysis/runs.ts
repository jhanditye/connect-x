// Runs (fast melismatic passages): at least four consecutive short note events, each a real step
// (>= 0.8 semitone) from the last, sung legato inside one phrase.
//
// Vibrato cannot trigger this: the note segmenter does not split a vibrato into notes (it needs a
// move of > 0.7 semitone that holds for 50 ms and shifts the ~150 ms average), and a slow scale's
// notes are longer than RUN_NOTE_MAX_SEC.

import type { Run } from '../types';
import type { NoteEvent } from './notes';

export const RUN_MIN_NOTES = 4;
/** Event length bounds for a run note. The segmenter keeps events down to 50 ms. */
export const RUN_NOTE_MIN_SEC = 0.05;
export const RUN_NOTE_MAX_SEC = 0.25;
export const RUN_MIN_STEP_SEMITONES = 0.8;
/** Consecutive run notes may be separated by at most this much unvoiced/unsegmented time. */
const RUN_MAX_GAP_SEC = 0.06;

function isRunNote(e: NoteEvent): boolean {
  const d = e.end - e.start;
  return d >= RUN_NOTE_MIN_SEC - 1e-9 && d <= RUN_NOTE_MAX_SEC + 1e-9;
}

export function detectRuns(events: NoteEvent[]): Run[] {
  const runs: Run[] = [];
  let seq: NoteEvent[] = [];
  const flush = () => {
    if (seq.length >= RUN_MIN_NOTES) {
      const start = seq[0].start;
      const end = seq[seq.length - 1].end;
      runs.push({ start, end, noteCount: seq.length, notesPerSec: seq.length / Math.max(1e-6, end - start) });
    }
    seq = [];
  };
  for (const e of events) {
    if (!isRunNote(e)) {
      flush();
      continue;
    }
    const prev = seq[seq.length - 1];
    const continues =
      prev !== undefined &&
      prev.phraseIndex === e.phraseIndex &&
      e.start - prev.end <= RUN_MAX_GAP_SEC + 1e-9 &&
      Math.abs(e.midi - prev.midi) >= RUN_MIN_STEP_SEMITONES;
    if (!continues) flush();
    seq.push(e);
  }
  flush();
  return runs;
}
