// Interval names and the ear-training interval sets. Equal temperament: an interval is a whole number of semitones.

import type { IntervalDirection, IntervalInfo, IntervalKey, SungDirection } from '../types';

export const INTERVALS: readonly IntervalInfo[] = Object.freeze([
  { semitones: 0, short: 'P1', name: 'unison', altName: null },
  { semitones: 1, short: 'm2', name: 'minor 2nd', altName: 'half step' },
  { semitones: 2, short: 'M2', name: 'major 2nd', altName: 'whole step' },
  { semitones: 3, short: 'm3', name: 'minor 3rd', altName: null },
  { semitones: 4, short: 'M3', name: 'major 3rd', altName: null },
  { semitones: 5, short: 'P4', name: 'perfect 4th', altName: null },
  { semitones: 6, short: 'TT', name: 'tritone', altName: 'augmented 4th / diminished 5th' },
  { semitones: 7, short: 'P5', name: 'perfect 5th', altName: null },
  { semitones: 8, short: 'm6', name: 'minor 6th', altName: null },
  { semitones: 9, short: 'M6', name: 'major 6th', altName: null },
  { semitones: 10, short: 'm7', name: 'minor 7th', altName: null },
  { semitones: 11, short: 'M7', name: 'major 7th', altName: null },
  { semitones: 12, short: 'P8', name: 'octave', altName: null },
  // Compound intervals: not used by the default sets, kept so the type stays open.
  { semitones: 13, short: 'm9', name: 'minor 9th', altName: null },
  { semitones: 14, short: 'M9', name: 'major 9th', altName: null },
  { semitones: 15, short: 'm10', name: 'minor 10th', altName: null },
  { semitones: 16, short: 'M10', name: 'major 10th', altName: null },
  { semitones: 17, short: 'P11', name: 'perfect 11th', altName: null },
] as IntervalInfo[]);

export const MAX_INTERVAL_SEMITONES = 17;
/** The simple intervals the ear trainer and the singing drills use (0..12). */
export const SIMPLE_INTERVALS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

/** Interval info for 0..17 semitones (sign ignored); null outside that. */
export function intervalInfo(semitones: number): IntervalInfo | null {
  if (!Number.isFinite(semitones)) return null;
  const s = Math.abs(Math.round(semitones));
  return INTERVALS[s] ?? null;
}

/** "major 6th" (capitalised: "Major 6th"). Empty string for an unknown interval. */
export function intervalName(semitones: number, capital = false): string {
  const name = intervalInfo(semitones)?.name ?? '';
  return capital && name ? name[0].toUpperCase() + name.slice(1) : name;
}

/** "M6". Empty string for an unknown interval. */
export function intervalShort(semitones: number): string {
  return intervalInfo(semitones)?.short ?? '';
}

/** "a major 6th up", "a perfect 4th down", "a major 3rd (together)", "the same note". */
export function intervalPhrase(semitones: number, direction: IntervalDirection): string {
  const s = Math.abs(Math.round(semitones));
  if (s === 0) return 'the same note';
  const name = intervalName(s);
  if (!name) return '';
  const article = /^[aeiou]/.test(name) || name.startsWith('octave') ? 'an' : 'a';
  const tail = direction === 'up' ? ' up' : direction === 'down' ? ' down' : ' (both notes together)';
  return `${article} ${name}${tail}`;
}

/** Stats key: "7u", "7d", "7h". */
export function intervalKey(semitones: number, direction: IntervalDirection): IntervalKey {
  const d = direction === 'up' ? 'u' : direction === 'down' ? 'd' : 'h';
  return `${Math.abs(Math.round(semitones))}${d}` as IntervalKey;
}

/** Inverse of intervalKey; null when malformed or out of 0..17. */
export function parseIntervalKey(key: string): { semitones: number; direction: IntervalDirection } | null {
  const m = /^(\d{1,2})([udh])$/.exec(key);
  if (!m) return null;
  const semitones = Number(m[1]);
  if (semitones > MAX_INTERVAL_SEMITONES) return null;
  const direction: IntervalDirection = m[2] === 'u' ? 'up' : m[2] === 'd' ? 'down' : 'harmonic';
  return { semitones, direction };
}

/** The second note of a melodic interval from `firstMidi` (harmonic counts as up from the lower note). */
export function intervalTargetMidi(firstMidi: number, semitones: number, direction: IntervalDirection | SungDirection): number {
  const s = Math.abs(Math.round(semitones));
  return direction === 'down' ? firstMidi - s : firstMidi + s;
}

/**
 * Ear-training levels. Each level adds intervals to the one before; level 1 is the "Starter" set the brief asks for
 * (P4, P5, P8, M3: the most distinct-sounding intervals). Level 5 is every simple interval except the unison.
 */
export const EAR_LEVELS: readonly { level: number; label: string; adds: readonly number[] }[] = Object.freeze([
  { level: 1, label: 'Starter', adds: [4, 5, 7, 12] },
  { level: 2, label: 'Level 2: thirds and steps', adds: [3, 2] },
  { level: 3, label: 'Level 3: sixths', adds: [9, 8] },
  { level: 4, label: 'Level 4: sevenths', adds: [10, 11] },
  { level: 5, label: 'Level 5: half step and tritone', adds: [1, 6] },
]);
export const MAX_EAR_LEVEL = EAR_LEVELS.length;

/** All intervals (semitones, ascending) up to and including `level` (clamped to 1..5). */
export function earSetForLevel(level: number): number[] {
  const lv = Math.max(1, Math.min(MAX_EAR_LEVEL, Math.round(Number.isFinite(level) ? level : 1)));
  const out: number[] = [];
  for (const l of EAR_LEVELS) if (l.level <= lv) out.push(...l.adds);
  return out.sort((a, b) => a - b);
}

/** A custom set cleaned up: whole semitones 0..12, unique, ascending; falls back to the Starter set when fewer than 2 remain. */
export function cleanIntervalSet(set: readonly number[]): number[] {
  const uniq = new Set<number>();
  for (const s of set) if (Number.isFinite(s) && s >= 0 && s <= 12) uniq.add(Math.round(s));
  const out = [...uniq].sort((a, b) => a - b);
  return out.length >= 2 ? out : earSetForLevel(1);
}

/**
 * Well-known song openings for ascending intervals, as listening hooks. Only widely cited, unambiguous examples; an
 * interval without one is simply absent.
 */
export const INTERVAL_SONG_HINTS: Readonly<Partial<Record<number, string>>> = Object.freeze({
  2: 'the first two different notes of "Happy Birthday" ("Happy Birth-")',
  5: '"Here Comes the Bride"',
  7: '"Twinkle, Twinkle, Little Star" ("Twinkle, twinkle")',
  9: '"My Bonnie Lies over the Ocean" ("My Bon-")',
  12: '"Somewhere Over the Rainbow" ("Some-where")',
});
