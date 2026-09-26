// Runs (fast melismatic passages): at least four consecutive short note events, each a real step
// (0.8-7 semitones) from the last, sung legato inside one phrase, at 6 or more notes per second.
// Runs move by steps and small skips; a jump of more than a fifth between run-length events was,
// on real recordings, the tracker jumping (an octave or harmonic error, or onto an instrument),
// so it ends the sequence.
//
// A very short event squeezed between two much longer ones is the pitch gliding from one note to
// the next (the segmenter keeps events down to 50 ms), not a sung note: it is skipped without
// breaking the sequence. Without this, a syllabic melody or a smooth glissando read as a run. The
// test is relative, not absolute, so a genuinely fast run of 60-80 ms notes still counts. The
// sliver limit stays under 60 ms: the short notes of a long-short (dotted or swung) run, such as
// 150/70 ms, also sit between notes twice their length and must not be skipped.
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
export const RUN_MAX_STEP_SEMITONES = 7;
/** Slower stepped passages are ordinary melody, not a run. */
export const RUN_MIN_NOTES_PER_SEC = 6;
/** Consecutive run notes may be separated by at most this much unvoiced/unsegmented time. */
const RUN_MAX_GAP_SEC = 0.06;
/** A glide sliver is shorter than this and has neighbours at least SLIVER_NEIGHBOUR_RATIO times as long. */
const SLIVER_MAX_SEC = 0.06;
const SLIVER_NEIGHBOUR_RATIO = 2;

const duration = (e: NoteEvent) => e.end - e.start;

function isRunNote(e: NoteEvent): boolean {
  const d = duration(e);
  return d >= RUN_NOTE_MIN_SEC - 1e-9 && d <= RUN_NOTE_MAX_SEC + 1e-9;
}

/** Whether events[i] is a transition sliver between two much longer events. */
function isSliver(events: NoteEvent[], i: number): boolean {
  const d = duration(events[i]);
  if (d >= SLIVER_MAX_SEC - 1e-9) return false;
  const prev = events[i - 1];
  const next = events[i + 1];
  return (
    prev !== undefined &&
    next !== undefined &&
    duration(prev) >= SLIVER_NEIGHBOUR_RATIO * d - 1e-9 &&
    duration(next) >= SLIVER_NEIGHBOUR_RATIO * d - 1e-9
  );
}

export function detectRuns(events: NoteEvent[]): Run[] {
  const runs: Run[] = [];
  let seq: NoteEvent[] = [];
  /** Length of the slivers skipped since the last run note; the allowed gap grows by it. */
  let skipped = 0;
  const flush = () => {
    if (seq.length >= RUN_MIN_NOTES) {
      const start = seq[0].start;
      const end = seq[seq.length - 1].end;
      const notesPerSec = seq.length / Math.max(1e-6, end - start);
      if (notesPerSec >= RUN_MIN_NOTES_PER_SEC) runs.push({ start, end, noteCount: seq.length, notesPerSec });
    }
    seq = [];
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (isSliver(events, i)) {
      skipped += duration(e);
      continue;
    }
    if (!isRunNote(e)) {
      flush();
      skipped = 0;
      continue;
    }
    const prev = seq[seq.length - 1];
    const continues =
      prev !== undefined &&
      prev.phraseIndex === e.phraseIndex &&
      e.start - prev.end <= RUN_MAX_GAP_SEC + skipped + 1e-9 &&
      Math.abs(e.midi - prev.midi) >= RUN_MIN_STEP_SEMITONES &&
      Math.abs(e.midi - prev.midi) <= RUN_MAX_STEP_SEMITONES;
    if (!continues) flush();
    seq.push(e);
    skipped = 0;
  }
  flush();
  return runs;
}
