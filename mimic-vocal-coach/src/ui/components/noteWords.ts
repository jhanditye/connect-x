// Plain words for the per-note findings, shared by the note table and the overlay plot. Pure functions, no DOM.

import type { NoteCompare, NoteFlag } from '../../types';
import { TRACKER_CEILING_MIDI, TRACKER_FLOOR_MIDI } from '../../trainer/keys';
import { formatCents } from './format';

const NAME_OFFSETS: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** "G#3" -> 56, or null for anything that is not a note name. */
export function noteNameMidi(name: string): number | null {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  return m ? NAME_OFFSETS[m[1]] + (Number(m[2]) + 1) * 12 : null;
}

/**
 * True when the note, in the singer's key, is outside what the pitch tracker can follow (about C2 to F6): it cannot be heard, so it
 * is not "missed" and not wrong. The score leaves such notes out and says why.
 */
export function outsideTrackerRange(n: NoteCompare): boolean {
  const m = noteNameMidi(n.refName);
  return m !== null && (m < TRACKER_FLOOR_MIDI + 0.5 || m > TRACKER_CEILING_MIDI - 0.5);
}

/** What a flag is called on screen. 'ok' and 'ornament' have no word. */
const FLAG_WORD: Partial<Record<NoteFlag, string>> = {
  flat: 'flat',
  sharp: 'sharp',
  'wrong-note': 'wrong note',
  'octave-displaced': 'octave off',
  early: 'early',
  late: 'late',
  short: 'short',
  long: 'long',
  missed: 'missed',
  merged: 'ran together',
  split: 'split',
};

export function flagWord(flag: NoteFlag): string | null {
  return FLAG_WORD[flag] ?? null;
}

/** Flags that mean the singer sang the wrong thing (or nothing), as opposed to a matter of degree. */
export function isSevereFlag(flag: NoteFlag): boolean {
  return flag === 'wrong-note' || flag === 'missed' || flag === 'octave-displaced';
}

const PITCH_FLAGS: ReadonlySet<NoteFlag> = new Set(['flat', 'sharp', 'wrong-note', 'octave-displaced']);
const TIMING_FLAGS: ReadonlySet<NoteFlag> = new Set(['late', 'early']);
const LENGTH_FLAGS: ReadonlySet<NoteFlag> = new Set(['short', 'long']);

export function pitchFlag(n: NoteCompare): NoteFlag | null {
  return n.flags.find((f) => PITCH_FLAGS.has(f)) ?? null;
}
export function timingFlag(n: NoteCompare): NoteFlag | null {
  return n.flags.find((f) => TIMING_FLAGS.has(f)) ?? null;
}
export function lengthFlag(n: NoteCompare): NoteFlag | null {
  return n.flags.find((f) => LENGTH_FLAGS.has(f)) ?? null;
}

/** True when the note has anything worth a word (a flag other than ok / ornament). */
export function isFlagged(n: NoteCompare): boolean {
  return n.flags.some((f) => FLAG_WORD[f] !== undefined);
}

/** "+125 ms" with a true minus sign. */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–';
  const r = Math.round(ms);
  return r === 0 ? '0 ms' : `${r > 0 ? '+' : '−'}${Math.abs(r)} ms`;
}

/** One line for a screen reader or a tooltip: "D3: sharp 38 cents, 125 ms late". Never empty. */
export function noteSummary(n: NoteCompare): string {
  if (n.flags.includes('missed') || !n.matched) return outsideTrackerRange(n) ? `${n.refName}: outside the range the app can follow` : `${n.refName}: not sung`;
  const parts: string[] = [];
  const pf = pitchFlag(n);
  if (pf === 'wrong-note') parts.push(`wrong note, you sang ${n.userName ?? 'a different note'}`);
  else if (pf === 'octave-displaced') parts.push(`sung an octave away${n.userName ? ` (${n.userName})` : ''}`);
  else if (pf && n.cents !== null) parts.push(`${pf} ${Math.round(Math.abs(n.cents))} cents`);
  const tf = timingFlag(n);
  if (tf && n.onsetMs !== null) parts.push(`${Math.round(Math.abs(n.onsetMs))} ms ${tf}`);
  const lf = lengthFlag(n);
  if (lf && n.durationDeltaMs !== null) parts.push(`held ${Math.round(Math.abs(n.durationDeltaMs))} ms ${lf === 'short' ? 'shorter' : 'longer'}`);
  if (n.flags.includes('merged')) parts.push('ran into the next note');
  return `${n.refName}: ${parts.length > 0 ? parts.join(', ') : 'on target'}`;
}

/** The pitch figure for the table: "+38¢", or a dash when it was not measured. */
export function pitchFigure(n: NoteCompare): string {
  return n.cents === null ? '–' : formatCents(n.cents);
}

/** "Shown in your key: an octave lower than the original." / "Shown in the original key." */
export function keyCaption(shift: number, biasCents: number, keyMode: 'free' | 'locked' = 'free'): string {
  const s = Math.round(shift);
  const n = Math.abs(s);
  const dir = s < 0 ? 'lower' : 'higher';
  const how = n === 12 ? `an octave ${dir}` : n > 12 && n % 12 === 0 ? `${n / 12} octaves ${dir}` : `${n} semitone${n === 1 ? '' : 's'} ${dir}`;
  const key = s === 0 ? 'Shown in the original key.' : `Shown in your key: ${how} than the original.`;
  if (keyMode === 'free' && Math.abs(biasCents) >= 20) {
    return `${key} You sang about ${Math.round(Math.abs(biasCents))} cents ${biasCents < 0 ? 'under' : 'over'} the original's pitch grid, which is not marked down in your own key.`;
  }
  return key;
}
