// Keys, scale degrees and how degrees are shown (numbers, movable-do solfege, note names in the key).

import { midiToHz } from '../../dsp/music';
import type { Degree, LabelMode, MusicalKey, ScaleMode, SeqNote, WrittenDegree } from '../types';

export const SCALE_MODES: readonly ScaleMode[] = Object.freeze(['major', 'natural-minor', 'harmonic-minor'] as ScaleMode[]);
export const DEGREES: readonly Degree[] = Object.freeze([1, 2, 3, 4, 5, 6, 7] as Degree[]);

/** Semitones above the tonic of degrees 1..7. */
export const SCALE_STEPS: Readonly<Record<ScaleMode, readonly number[]>> = Object.freeze({
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  'natural-minor': Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  'harmonic-minor': Object.freeze([0, 2, 3, 5, 7, 8, 11]),
});

export const SCALE_MODE_LABELS: Readonly<Record<ScaleMode, string>> = Object.freeze({
  major: 'Major',
  'natural-minor': 'Natural minor',
  'harmonic-minor': 'Harmonic minor',
});

/** Movable do, do-based minor (b3 me, b6 le, b7 te); la-based minor is deliberately not used. */
export const SOLFEGE: Readonly<Record<ScaleMode, readonly string[]>> = Object.freeze({
  major: Object.freeze(['do', 're', 'mi', 'fa', 'sol', 'la', 'ti']),
  'natural-minor': Object.freeze(['do', 're', 'me', 'fa', 'sol', 'le', 'te']),
  'harmonic-minor': Object.freeze(['do', 're', 'me', 'fa', 'sol', 'le', 'ti']),
});

export function isDegree(x: unknown): x is Degree {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 7;
}

export function isScaleMode(x: unknown): x is ScaleMode {
  return typeof x === 'string' && (SCALE_MODES as readonly string[]).includes(x);
}

/** Semitones above the tonic for a written degree 1..8 (8 = 12). */
export function degreeSemitones(degree: WrittenDegree, mode: ScaleMode): number {
  if (degree === 8) return 12;
  return SCALE_STEPS[mode][degree - 1];
}

/** Absolute pitch of a line note in a key. */
export function noteMidi(key: MusicalKey, note: Pick<SeqNote, 'semitones'>): number {
  return key.tonicMidi + note.semitones;
}

/** Frequency of a line note in a key at the user's A4. */
export function noteHz(key: MusicalKey, note: Pick<SeqNote, 'semitones'>, a4Hz: number): number {
  return midiToHz(noteMidi(key, note), a4Hz);
}

/** Degree (1..7) of a pitch in a key, or null when it is not in the scale. */
export function degreeOfMidi(key: MusicalKey, midi: number): Degree | null {
  const rel = (((Math.round(midi) - Math.round(key.tonicMidi)) % 12) + 12) % 12;
  const i = SCALE_STEPS[key.mode].indexOf(rel);
  return i >= 0 ? ((i + 1) as Degree) : null;
}

// ---------------------------------------------------------------------------------------------
// Note names

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

/**
 * Conventional tonic spelling per pitch class (fewest accidentals; F# major and Eb minor at the six-accidental keys,
 * which singers meet more often than Gb major / D# minor).
 */
const MAJOR_TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

function pcOf(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

function accidental(n: number): string {
  if (n > 0) return '#'.repeat(n);
  if (n < 0) return 'b'.repeat(-n);
  return '';
}

/** Tonic name for a key: "Eb", "F#", "C#" (ASCII # and b; see prettyAccidentals). */
export function keyTonicName(key: MusicalKey): string {
  const pc = pcOf(key.tonicMidi);
  return key.mode === 'major' ? MAJOR_TONICS[pc] : MINOR_TONICS[pc];
}

/** "Eb major", "A minor", "G# harmonic minor". */
export function keyName(key: MusicalKey): string {
  const mode = key.mode === 'major' ? 'major' : key.mode === 'natural-minor' ? 'minor' : 'harmonic minor';
  return `${prettyAccidentals(keyTonicName(key))} ${mode}`;
}

/**
 * The scale degree spelled with the right letter for the key: degree 7 of F# major is "E#", degree 7 of G# harmonic
 * minor is "F##". ASCII accidentals.
 */
export function spellDegree(key: MusicalKey, degree: Degree): string {
  const tonic = keyTonicName(key);
  const letterIdx = LETTERS.indexOf(tonic[0] as (typeof LETTERS)[number]);
  const li = (letterIdx + degree - 1) % 7;
  const targetPc = (pcOf(key.tonicMidi) + SCALE_STEPS[key.mode][degree - 1]) % 12;
  let diff = (targetPc - LETTER_PC[li] + 12) % 12;
  if (diff > 6) diff -= 12;
  return LETTERS[li] + accidental(diff);
}

/** Spelled name with octave number, e.g. "E#4" for MIDI 65 as degree 7 of F# major (octave follows the letter). */
export function spellDegreeWithOctave(key: MusicalKey, degree: Degree, midi: number): string {
  const name = spellDegree(key, degree);
  const acc = (name.match(/#/g)?.length ?? 0) - (name.match(/b/g)?.length ?? 0);
  const natural = Math.round(midi) - acc;
  const octave = Math.floor(natural / 12) - 1;
  return `${name}${octave}`;
}

/** "#" -> "♯", "b" -> "♭" for display (only in accidental position, so the letter B is kept). */
export function prettyAccidentals(name: string): string {
  return name.replace(/^([A-G])([#b]+)/, (_m, letter: string, acc: string) => letter + acc.replace(/#/g, '♯').replace(/b/g, '♭'));
}

// ---------------------------------------------------------------------------------------------
// Display labels

export interface DegreeLabel {
  /** "7", "ti", "B" */
  text: string;
  /** Octave relative to the home octave for display: -1 = draw a dot below, +1 = a dot above (8 shows as 8, octave 0). */
  octaveMark: number;
}

/** How one line note is shown in the chosen mode. Names mode needs the key's tonic. */
export function degreeLabel(note: Pick<SeqNote, 'degree' | 'written' | 'octave'>, mode: ScaleMode, labelMode: LabelMode, key?: MusicalKey): DegreeLabel {
  const shownOctave = note.written === 8 ? note.octave - 1 : note.octave;
  if (labelMode === 'solfege') return { text: SOLFEGE[mode][note.degree - 1], octaveMark: note.octave };
  if (labelMode === 'names') {
    const k = key ?? { tonicMidi: 60, mode };
    return { text: prettyAccidentals(spellDegree({ tonicMidi: k.tonicMidi, mode }, note.degree)), octaveMark: note.octave };
  }
  return { text: String(note.written), octaveMark: shownOctave };
}

/** The labels of a whole line, e.g. ["7", "6", "5"] or ["ti", "la", "sol"]. */
export function lineLabels(notes: readonly Pick<SeqNote, 'degree' | 'written' | 'octave'>[], mode: ScaleMode, labelMode: LabelMode, key?: MusicalKey): DegreeLabel[] {
  return notes.map((n) => degreeLabel(n, mode, labelMode, key));
}

/** Plain-text label with octave marks for screen readers and summaries: "7 (low)", "do (high)". */
export function degreeLabelText(label: DegreeLabel): string {
  if (label.octaveMark < 0) return `${label.text} (low${label.octaveMark < -1 ? `, ${-label.octaveMark} octaves down` : ''})`;
  if (label.octaveMark > 0) return `${label.text} (high${label.octaveMark > 1 ? `, ${label.octaveMark} octaves up` : ''})`;
  return label.text;
}

// ---------------------------------------------------------------------------------------------
// Cadence

/**
 * I-IV-V7-I (minor: i-iv-V7-i with the harmonic-minor raised 7th) in close voicing around the tonic, each chord with a
 * bass note below. In C: C3+C4 E4 G4, F3+C4 F4 A4, G2+B3 D4 F4 G4, C3+C4 E4 G4. Returned lowest note first.
 */
export function cadenceChords(key: MusicalKey): number[][] {
  const t = Math.round(key.tonicMidi);
  const minor = key.mode !== 'major';
  const third = minor ? 3 : 4;
  const sixth = minor ? 8 : 9;
  return [
    [t - 12, t, t + third, t + 7],
    [t - 7, t, t + 5, t + sixth],
    [t - 17, t - 1, t + 2, t + 5, t + 7],
    [t - 12, t, t + third, t + 7],
  ];
}
