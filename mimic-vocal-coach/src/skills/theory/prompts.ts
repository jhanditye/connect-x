// What the prompt player plays, as pure timed events (src/skills/audio plays them with the piano voice of
// src/audio/tones.ts). Prompts always finish before capture starts, so nothing leaks from the speakers into a take.

import type { EarQuestion, IntervalDirection, MusicalKey, SequenceTarget, ToneEvent } from '../types';
import { intervalTargetMidi } from './intervals';
import { cadenceChords } from './scales';

export const PROMPT_TIMING = Object.freeze({
  /** Pitch test / match: the target note. */
  singleNoteSec: 1.2,
  /** Silence between the end of a prompt and the start of capture (lets the room and the speaker ring out). */
  beforeCaptureSec: 0.35,
  intervalNoteSec: 0.9,
  intervalGapSec: 0.15,
  harmonicSec: 1.6,
  chordSec: 0.65,
  finalChordSec: 1.0,
  cadenceToTonicGapSec: 0.35,
  tonicSec: 1.0,
  lineNoteSec: 0.6,
  lineGapSec: 0.06,
  /** Gap between replaying "your answer" and "the right one" after a wrong ear answer. */
  compareGapSec: 0.6,
});

/** Total length of a list of events (end of the last one). */
export function eventsDuration(events: readonly ToneEvent[]): number {
  let end = 0;
  for (const e of events) end = Math.max(end, e.startSec + e.durSec);
  return end;
}

/** Events moved later by `dt` seconds. */
export function shiftEvents(events: readonly ToneEvent[], dt: number): ToneEvent[] {
  return events.map((e) => ({ ...e, midis: e.midis.slice(), startSec: e.startSec + dt }));
}

/** Plays `b` after `a` with `gapSec` between. */
export function concatEvents(a: readonly ToneEvent[], b: readonly ToneEvent[], gapSec = 0): ToneEvent[] {
  return [...a.map((e) => ({ ...e, midis: e.midis.slice() })), ...shiftEvents(b, a.length > 0 ? eventsDuration(a) + gapSec : 0)];
}

/** One note. */
export function noteEvents(midi: number, durSec: number = PROMPT_TIMING.singleNoteSec, role: ToneEvent['role'] = 'reference'): ToneEvent[] {
  return [{ midis: [midi], startSec: 0, durSec, role }];
}

/** Two notes one after the other, or together for 'harmonic'. */
export function intervalEvents(firstMidi: number, semitones: number, direction: IntervalDirection): ToneEvent[] {
  const second = intervalTargetMidi(firstMidi, semitones, direction);
  if (direction === 'harmonic') return [{ midis: [firstMidi, second], startSec: 0, durSec: PROMPT_TIMING.harmonicSec, gain: 0.8, role: 'reference' }];
  const t = PROMPT_TIMING;
  return [
    { midis: [firstMidi], startSec: 0, durSec: t.intervalNoteSec, role: 'reference' },
    { midis: [second], startSec: t.intervalNoteSec + t.intervalGapSec, durSec: t.intervalNoteSec, role: 'target' },
  ];
}

/** I-IV-V7-I, then (by default) the tonic alone. */
export function cadenceEvents(key: MusicalKey, withTonic = true): ToneEvent[] {
  const t = PROMPT_TIMING;
  const chords = cadenceChords(key);
  const out: ToneEvent[] = chords.map((midis, i) => ({
    midis,
    startSec: i * t.chordSec,
    durSec: i === chords.length - 1 ? t.finalChordSec : t.chordSec * 0.95,
    gain: 0.6,
    role: 'cadence' as const,
  }));
  if (withTonic) {
    out.push({ midis: [Math.round(key.tonicMidi)], startSec: eventsDuration(out) + t.cadenceToTonicGapSec, durSec: t.tonicSec, role: 'tonic' });
  }
  return out;
}

/** The line itself, one note per degree (for "Listen and repeat"). */
export function lineEvents(target: Pick<SequenceTarget, 'midis'>, noteSec: number = PROMPT_TIMING.lineNoteSec): ToneEvent[] {
  const step = noteSec + PROMPT_TIMING.lineGapSec;
  return target.midis.map((m, i) => ({ midis: [m], startSec: i * step, durSec: noteSec, role: 'line' as const, index: i }));
}

/** What an ear question plays: an interval, or the cadence then the single degree note. */
export function earQuestionEvents(q: EarQuestion): ToneEvent[] {
  if (q.kind === 'interval') return intervalEvents(q.firstMidi, q.semitones, q.direction);
  return concatEvents(cadenceEvents(q.key, false), noteEvents(q.midi, PROMPT_TIMING.tonicSec, 'target'), PROMPT_TIMING.cadenceToTonicGapSec + 0.25);
}

/** After a wrong interval answer: the singer's answer, a gap, then the right interval (both from the same first note). */
export function compareIntervalEvents(firstMidi: number, chosen: number, correct: number, direction: IntervalDirection): ToneEvent[] {
  const yours = intervalEvents(firstMidi, chosen, direction).map((e) => ({ ...e, role: 'answer' as const }));
  return concatEvents(yours, intervalEvents(firstMidi, correct, direction), PROMPT_TIMING.compareGapSec);
}
