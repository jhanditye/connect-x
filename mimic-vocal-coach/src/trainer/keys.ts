// Key helpers for the "guide in my key" chip and the key line on the result. Pure functions (owner: W2 import, shared with
// W3 audio and the practice screen).

import { midiToNoteName } from '../dsp/music';

/** The tracker's floor is 65 Hz (MIDI 36.4); a reference moved below C2 cannot be followed. */
export const TRACKER_FLOOR_MIDI = 36;
/** And its ceiling is 1400 Hz (MIDI 89.2). */
export const TRACKER_CEILING_MIDI = 89;

/** Largest shift the guide offers directly; beyond it the octave-equivalent is offered (a smaller shift keeps the guide natural). */
export const MAX_GUIDE_SHIFT = 7;

/**
 * The transposition to offer as the guide shift after a scored attempt, from the shift the singer used. Up to 7 semitones
 * either way it is the singer's own shift; an exact octave stays an octave; anything in between or beyond is folded to the
 * octave-equivalent within 7 semitones (a guide moved 9 semitones up is the same notes as one 3 down). Never NaN.
 */
export function suggestGuideShift(attemptShift: number): number {
  if (!Number.isFinite(attemptShift)) return 0;
  const n = Math.round(attemptShift);
  if (Math.abs(n) <= MAX_GUIDE_SHIFT) return n;
  if (Math.abs(n) === 12) return n;
  let r = ((n % 12) + 12) % 12; // 0..11
  if (r > 6) r -= 12;
  return r;
}

/** "Original key", "My key +3", "My key -12 (octave)". */
export function shiftLabel(shift: number): string {
  if (!Number.isFinite(shift) || Math.round(shift) === 0) return 'Original key';
  const n = Math.round(shift);
  return `My key ${n > 0 ? '+' : '-'}${Math.abs(n)}${Math.abs(n) === 12 ? ' (octave)' : ''}`;
}

/** True when the reference, moved by `shift`, would sit below what the pitch tracker can follow. */
export function belowTrackerRange(refMedianMidi: number, shift: number): boolean {
  return refMedianMidi + shift < TRACKER_FLOOR_MIDI;
}

/** True when it would sit above what the pitch tracker can follow. */
export function aboveTrackerRange(refMedianMidi: number, shift: number): boolean {
  return refMedianMidi + shift > TRACKER_CEILING_MIDI;
}

/**
 * The message for a shift the app cannot follow, or null when the shifted reference is trackable. Says what to do instead
 * (sing the other octave) so the singer is never left at a dead end.
 */
export function rangeMessage(refMedianMidi: number, shift: number): string | null {
  if (!Number.isFinite(refMedianMidi) || !Number.isFinite(shift)) return null;
  if (belowTrackerRange(refMedianMidi, shift)) {
    return 'This is below the range the app can follow. Sing it an octave up instead, or pick the original key.';
  }
  if (aboveTrackerRange(refMedianMidi, shift)) {
    return 'This is above the range the app can follow. Sing it an octave down instead, or pick the original key.';
  }
  return null;
}

/** "an octave lower", "3 semitones higher". */
function interval(shift: number): string {
  const n = Math.abs(Math.round(shift));
  const dir = shift < 0 ? 'lower' : 'higher';
  if (n === 12) return `an octave ${dir}`;
  if (n > 12 && n % 12 === 0) return `${n / 12} octaves ${dir}`;
  return `${n} semitone${n === 1 ? '' : 's'} ${dir}`;
}

/** "Original E4, your key E3 (an octave lower)" for the result sheet; "Original key (E4)" when there is no shift. */
export function keyLine(refMedianMidi: number, shift: number): string {
  if (!Number.isFinite(refMedianMidi)) return shiftLabel(shift);
  const s = Number.isFinite(shift) ? Math.round(shift) : 0;
  const orig = midiToNoteName(refMedianMidi);
  if (s === 0) return `Original key (${orig})`;
  return `Original ${orig}, your key ${midiToNoteName(refMedianMidi + s)} (${interval(s)})`;
}

/** The guide-key chips to offer: the original, plus the suggested shift when it differs. */
export function guideShiftChoices(attemptShift: number | null): number[] {
  if (attemptShift === null) return [0];
  const s = suggestGuideShift(attemptShift);
  return s === 0 ? [0] : [0, s];
}
