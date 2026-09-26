// Pitch-unit conversions and note names (equal temperament, MIDI numbering: A4 = 69, C4 = 60).

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Fractional MIDI note number of a frequency. NaN for non-positive or non-finite input. */
export function hzToMidi(hz: number, a4Hz = 440): number {
  if (!(hz > 0) || !Number.isFinite(hz)) return NaN;
  return 69 + 12 * Math.log2(hz / a4Hz);
}

export function midiToHz(midi: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, (midi - 69) / 12);
}

/** 60 -> "C4", 61 -> "C#4". Rounds to the nearest note; uses sharps. Returns "" for non-finite input. */
export function midiToNoteName(midi: number): string {
  if (!Number.isFinite(midi)) return '';
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return `${SHARP_NAMES[pc]}${octave}`;
}

/**
 * Parses "C#4", "Db4", "c4", "Bb-1", "F##3" (also accepts the Unicode sharp/flat signs).
 * The first letter is always the note letter, so "bb3" is B-flat 3. Returns NaN if unparseable.
 */
export function noteNameToMidi(name: string): number {
  const m = /^\s*([A-Ga-g])([#b♯♭]*)\s*(-?\d+)\s*$/.exec(name);
  if (!m) return NaN;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : -1;
  const octave = parseInt(m[3], 10);
  return (octave + 1) * 12 + pc;
}

/** Interval from hzA to hzB in cents: positive when B is higher than A. NaN for invalid input. */
export function centsBetween(hzA: number, hzB: number): number {
  if (!(hzA > 0) || !(hzB > 0)) return NaN;
  return 1200 * Math.log2(hzB / hzA);
}
