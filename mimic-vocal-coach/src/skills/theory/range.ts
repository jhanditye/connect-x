// Comfortable singing ranges per voice type and fitting lines into them. Nothing the Skills section asks for may lie
// outside the singer's comfortable range.
//
// The top of the range is a few semitones (COMFORT_ABOVE_PASSAGGIO) above the start of the voice type's passaggio zone
// (src/analysis/passaggio.ts), so fundamentals are practised where the voice is easy; the bottom is a conservative low
// note per voice type. Both are approximate: Settings can override them (SkillsPrefs.rangeOverride).

import { passaggioFor } from '../../analysis/passaggio';
import type { VoiceType } from '../../types';
import type { MusicalKey, RegisterThird, ScaleMode, SeqNote, SequenceTarget, VoiceRange } from '../types';
import { pick, type Rng } from './rng';
import { lineSpan, sequenceText } from './sequence';

/** Comfortable low note (MIDI) per voice type: F2, A2, C3, F3, G3, A3. */
export const COMFORTABLE_LOW_MIDI: Readonly<Record<VoiceType, number>> = Object.freeze({
  bass: 41,
  baritone: 45,
  tenor: 48,
  alto: 53,
  mezzo: 55,
  soprano: 57,
});
export const COMFORT_ABOVE_PASSAGGIO = 3;
/** Narrowest range accepted from an override (an octave and a fourth: room for the longest presets). */
export const MIN_RANGE_SEMITONES = 12;

/** Comfortable range: the override when it is sane, else from the voice type (e.g. baritone A2-F4 = 45-65). */
export function comfortableRange(voiceType: VoiceType, override?: VoiceRange | null): VoiceRange {
  if (
    override &&
    Number.isFinite(override.lowMidi) &&
    Number.isFinite(override.highMidi) &&
    override.highMidi - override.lowMidi >= MIN_RANGE_SEMITONES &&
    override.lowMidi >= 28 &&
    override.highMidi <= 96
  ) {
    return { lowMidi: Math.round(override.lowMidi), highMidi: Math.round(override.highMidi) };
  }
  const low = COMFORTABLE_LOW_MIDI[voiceType] ?? COMFORTABLE_LOW_MIDI.baritone;
  const high = passaggioFor(voiceType).lowMidi + COMFORT_ABOVE_PASSAGGIO;
  return { lowMidi: low, highMidi: high };
}

/** Splits the range into three bands of near-equal size: [low..a], [a+1..b], [b+1..high]. */
export function registerBands(range: VoiceRange): Record<RegisterThird, VoiceRange> {
  const size = range.highMidi - range.lowMidi + 1;
  const a = range.lowMidi + Math.round(size / 3) - 1;
  const b = range.lowMidi + Math.round((2 * size) / 3) - 1;
  return {
    low: { lowMidi: range.lowMidi, highMidi: a },
    mid: { lowMidi: a + 1, highMidi: b },
    high: { lowMidi: b + 1, highMidi: range.highMidi },
  };
}

/** Which third of the range a pitch is in (values outside the range count as the nearest end). */
export function registerThirdOf(midi: number, range: VoiceRange): RegisterThird {
  const bands = registerBands(range);
  const m = Math.round(midi);
  if (m <= bands.low.highMidi) return 'low';
  if (m <= bands.mid.highMidi) return 'mid';
  return 'high';
}

export function inRange(midi: number, range: VoiceRange): boolean {
  return midi >= range.lowMidi && midi <= range.highMidi;
}

/**
 * Tonics (MIDI) that put every semitone offset of a line inside the range, keeping `margin` semitones from the edges
 * when possible (tries margin, then 0). Sorted by how close the line's centre is to the range's centre. Empty when the
 * line is wider than the range.
 */
export function candidateTonics(offsets: readonly number[], range: VoiceRange, margin = 1): number[] {
  if (offsets.length === 0) return [];
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  const centre = (range.lowMidi + range.highMidi) / 2;
  for (const m of margin > 0 ? [margin, 0] : [0]) {
    const lo = range.lowMidi + m - min;
    const hi = range.highMidi - m - max;
    if (hi < lo) continue;
    const out: number[] = [];
    for (let t = lo; t <= hi; t++) out.push(t);
    return out.sort((a, b) => Math.abs(a + (min + max) / 2 - centre) - Math.abs(b + (min + max) / 2 - centre) || a - b);
  }
  return [];
}

/**
 * A tonic for the line: without an rng the most central one; with an rng a random one among those whose centre is
 * within `spread` semitones of the best (variety of keys, still near the middle). Null when the line cannot fit.
 */
export function fitTonic(offsets: readonly number[], range: VoiceRange, rng?: Rng, spread = 2): number | null {
  const cands = candidateTonics(offsets, range);
  if (cands.length === 0) return null;
  if (!rng) return cands[0];
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  const centre = (range.lowMidi + range.highMidi) / 2;
  const bestOff = Math.abs(cands[0] + (min + max) / 2 - centre);
  const near = cands.filter((t) => Math.abs(t + (min + max) / 2 - centre) <= bestOff + spread);
  return pick(rng, near);
}

/** A playable target for parsed notes, or null when the line does not fit the range in any key. */
export function fitSequence(notes: readonly SeqNote[], mode: ScaleMode, range: VoiceRange, rng?: Rng, text?: string): SequenceTarget | null {
  const tonic = fitTonic(
    notes.map((n) => n.semitones),
    range,
    rng,
  );
  if (tonic === null) return null;
  const key: MusicalKey = { tonicMidi: tonic, mode };
  return { key, notes: notes.slice(), midis: notes.map((n) => tonic + n.semitones), text: text ?? sequenceText(notes) };
}

/** Plain sentence for a line that will not fit, with the numbers. */
export function tooWideMessage(notes: readonly SeqNote[], range: VoiceRange): string {
  const { span } = lineSpan(notes);
  const room = range.highMidi - range.lowMidi;
  return `That line spans ${span} semitones but your comfortable range is ${room}. Try a shorter line, or fewer octave marks.`;
}
