// The scale-degree line parser: what the singer types ("7 6 5 4 3 2", "2 7 6 5", "1 3 5 8 5 3 1", "1 7- 1 2 1")
// becomes notes placed relative to the tonic.
//
// Syntax
// - Degrees 1..8 (8 = the tonic an octave up). Spaces and commas separate degrees; digits may also run together
//   ("765432" = 7 6 5 4 3 2).
// - Octave marks directly after a degree: "-" (or "_") = one octave below the home octave, "+" or "'" = one above;
//   marks stack ("5--") up to two octaves. Marks are absolute: "7-" is always the 7 below the home tonic.
// - 8 is absolute too: always the tonic an octave above the home tonic (8 = "1+"), wherever it appears.
// - Commas are separators, not octave marks (see SPEC.md: "7,6,5" and "7, 6, 5" are how people type lists).
//
// Octave rule for unmarked degrees
// - The first degree sits in the home octave: 1..7 above the tonic (8 = the octave).
// - Each later degree stays in the home octave (1 up to 8) when the step from the previous note is a 5th or less, so
//   "1 5" rises a 5th, "1 5 8 5 1" is the usual arpeggio and "3 6 2 5 1" stays between 1 and 6.
// - A step that would be wider than a 5th crosses into the next octave instead: the degree takes the octave nearest
//   the previous note ("2 7 6 5": the 7 is just below the 2; "6 7 1 2": the 1 is the 8 above). On an exact tie (a
//   tritone) it takes the octave nearer the line's first note; if that is a tie too, the direction of the overall
//   line (last typed degree vs first); if the line is flat, down.
// - In a line that contains an 8, an unmarked 1 is always the home tonic ("1 8 1", "8 5 1", "5 8 1" come home).
// - Marks always win: "1 5-" is the 5 below, "1 5+" the 5 an octave above the home one.

import type { Degree, ScaleMode, SeqNote, SequenceParse, WrittenDegree } from '../types';
import { SCALE_STEPS, degreeSemitones } from './scales';

export const MAX_SEQUENCE_NOTES = 16;
export const MAX_OCTAVE_MARKS = 2;
/** An unmarked degree stays in the home octave when the step there is at most this many semitones (a 5th). */
export const HOME_WINDOW_MAX_STEP = 7;

export const SEQUENCE_EXAMPLE = '7 6 5 4 3 2';

interface Token {
  written: WrittenDegree;
  /** Octave from explicit marks, null when unmarked. */
  marks: number | null;
  at: number;
}

type TokenResult = { ok: true; tokens: Token[] } | { ok: false; error: string; at: number | null };

const DOWN_MARKS = new Set(['-', '_']);
const UP_MARKS = new Set(['+', "'", '’']);
const SEPARATORS = /[\s,;/|]/;

function fail(error: string, at: number | null): { ok: false; error: string; at: number | null } {
  return { ok: false, error, at };
}

/** Splits the text into degree tokens with their octave marks. */
export function tokenizeSequence(text: string): TokenResult {
  const tokens: Token[] = [];
  const s = text ?? '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (SEPARATORS.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      // A run of digits: single degrees run together, unless it reads as one number of 9 or more.
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length > 1 && /^[1-8]+$/.test(run)) {
        for (let k = 0; k < run.length - 1; k++) tokens.push({ written: Number(run[k]) as WrittenDegree, marks: null, at: i + k });
      } else if (run.length > 1) {
        const n = Number(run);
        if (n >= 9 && n <= 15) {
          const deg = n - 7;
          return fail(`${run} is beyond the octave: write ${deg}+ for the ${run}th (${deg} an octave up).`, i);
        }
        if (/0/.test(run)) return fail(`0 isn't a scale degree: use 1 to 8.`, i + run.indexOf('0'));
        return fail(`${run} isn't a scale degree: use 1 to 8, with + or - for another octave.`, i);
      }
      const last = run[run.length - 1];
      const at = j - 1;
      if (last === '0') return fail(`0 isn't a scale degree: use 1 to 8.`, at);
      if (last === '9') return fail(`9 is beyond the octave: write 2+ for the 9th (2 an octave up).`, at);
      // Marks after the (last) digit.
      let k = j;
      let marks = 0;
      let marked = false;
      while (k < s.length && (DOWN_MARKS.has(s[k]) || UP_MARKS.has(s[k]))) {
        marks += DOWN_MARKS.has(s[k]) ? -1 : 1;
        marked = true;
        k++;
      }
      if (Math.abs(marks) > MAX_OCTAVE_MARKS) return fail(`At most ${MAX_OCTAVE_MARKS} octave marks on one degree.`, j);
      tokens.push({ written: Number(last) as WrittenDegree, marks: marked ? marks : null, at });
      i = k;
      continue;
    }
    if (DOWN_MARKS.has(ch) || UP_MARKS.has(ch)) {
      return fail(`Put octave marks after the degree: "3-" is the 3 below, "3+" the 3 above.`, i);
    }
    if (/[#b♯♭]/.test(ch) && /[0-9]/.test(s[i + 1] ?? '')) {
      return fail(`Sharps and flats aren't supported yet: use the degrees 1 to 8 of the scale.`, i);
    }
    if (/[a-z]/i.test(ch)) {
      return fail(`Letters aren't scale degrees: type numbers 1 to 8, like ${SEQUENCE_EXAMPLE}.`, i);
    }
    return fail(`"${ch}" isn't understood: type numbers 1 to 8 separated by spaces, like ${SEQUENCE_EXAMPLE}.`, i);
  }
  if (tokens.length === 0) return fail(`Type some scale degrees, like ${SEQUENCE_EXAMPLE}.`, null);
  if (tokens.length > MAX_SEQUENCE_NOTES) return fail(`That's ${tokens.length} notes: ${MAX_SEQUENCE_NOTES} is the most one take can score.`, tokens[MAX_SEQUENCE_NOTES].at);
  return { ok: true, tokens };
}

function degreeOf(written: WrittenDegree): Degree {
  return (written === 8 ? 1 : written) as Degree;
}

/** Index in "degree number space" so the overall direction can be read from typed numbers (8 above 7, marks = 7 steps). */
function lineIndex(t: { written: WrittenDegree; marks: number | null }): number {
  return t.written + 7 * (t.marks ?? 0);
}

/**
 * Places degree tokens in octaves (rules at the top of this file). Exported for generators, which build tokens
 * directly; `marks` null = unmarked.
 */
export function placeDegrees(tokens: readonly { written: WrittenDegree; marks: number | null }[], mode: ScaleMode): SeqNote[] {
  const notes: SeqNote[] = [];
  if (tokens.length === 0) return notes;
  const overall = Math.sign(lineIndex(tokens[tokens.length - 1]) - lineIndex(tokens[0]));
  const hasEight = tokens.some((t) => t.written === 8);
  let first = 0;
  let prev = 0;
  tokens.forEach((t, idx) => {
    const degree = degreeOf(t.written);
    const step = SCALE_STEPS[mode][degree - 1];
    const writtenOctave = t.written === 8 ? 1 : 0;
    let octave: number;
    if (t.marks !== null || t.written === 8) {
      octave = writtenOctave + (t.marks ?? 0);
    } else if (idx === 0) {
      octave = writtenOctave;
    } else if (Math.abs(step - prev) <= HOME_WINDOW_MAX_STEP || (hasEight && t.written === 1)) {
      // Stays in the home octave (1 up to 8).
      octave = 0;
    } else {
      // Nearest octave to the previous note; candidates around it.
      const base = Math.floor((prev - step) / 12);
      let best: number | null = null;
      let bestKey: [number, number, number] | null = null;
      for (const o of [base - 1, base, base + 1, base + 2]) {
        const semis = o * 12 + step;
        const dist = Math.abs(semis - prev);
        const toFirst = Math.abs(semis - first);
        const dirPenalty = overall === 0 ? (semis < prev ? 0 : 1) : Math.sign(semis - prev) === overall ? 0 : 1;
        const key: [number, number, number] = [dist, toFirst, dirPenalty];
        if (
          bestKey === null ||
          key[0] < bestKey[0] ||
          (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
        ) {
          best = o;
          bestKey = key;
        }
      }
      octave = best ?? 0;
    }
    const semitones = octave * 12 + step;
    // `octave` above is the octave of the *degree*; 8 written with no marks is degree 1 in octave 1.
    notes.push({ degree, written: t.written, octave, semitones, explicit: t.marks !== null || t.written === 8 });
    if (idx === 0) first = semitones;
    prev = semitones;
  });
  return notes;
}

/** Canonical text with explicit marks: "2 7- 6- 5-", "1 3 5 8". Parsing it gives the same notes. */
export function sequenceText(notes: readonly Pick<SeqNote, 'written' | 'octave'>[]): string {
  return notes
    .map((n) => {
      const rel = n.written === 8 ? n.octave - 1 : n.octave;
      return String(n.written) + (rel < 0 ? '-'.repeat(-rel) : "+".repeat(Math.max(0, rel)));
    })
    .join(' ');
}

/** Parses what the singer typed. Never throws; errors are plain sentences with the character position. */
export function parseSequence(text: string, mode: ScaleMode = 'major'): SequenceParse {
  const tok = tokenizeSequence(text);
  if (!tok.ok) return tok;
  const notes = placeDegrees(tok.tokens, mode);
  const span = Math.max(...notes.map((n) => n.semitones)) - Math.min(...notes.map((n) => n.semitones));
  if (span > 24) return { ok: false, error: 'That line spans more than two octaves: no voice can sing it comfortably in one key.', at: null };
  let normalized = sequenceText(notes);
  // Odd mark combinations ("4+-") can place a note where the canonical text would not: keep the typed text then.
  const again = tokenizeSequence(normalized);
  const same = again.ok && placeDegrees(again.tokens, mode).every((n, i) => n.semitones === notes[i].semitones);
  if (!same) normalized = text.trim().replace(/\s+/g, ' ');
  return { ok: true, notes, normalized };
}

/** Lowest and highest semitone of a line (relative to the tonic). */
export function lineSpan(notes: readonly Pick<SeqNote, 'semitones'>[]): { min: number; max: number; span: number } {
  if (notes.length === 0) return { min: 0, max: 0, span: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes) {
    min = Math.min(min, n.semitones);
    max = Math.max(max, n.semitones);
  }
  return { min, max, span: max - min };
}

/** Steps between neighbours in semitones (signed), e.g. "7 6 5" major -> [-2, -2]. */
export function lineSteps(notes: readonly Pick<SeqNote, 'semitones'>[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < notes.length; i++) out.push(notes[i].semitones - notes[i - 1].semitones);
  return out;
}

/** Degree written as typed, for generators: "7" -> semitones in a mode, in the home octave. */
export function writtenSemitones(written: WrittenDegree, mode: ScaleMode): number {
  return degreeSemitones(written, mode);
}
