// Scores a take's StyleVector against a singer profile and explains each dimension in plain words.

import { midiToNoteName } from '../dsp/music';
import type { Comparison, DimensionResult, Direction, SingerProfile, StyleKey, TargetBand, VoiceAnalysis } from '../types';
import { STYLE_KEYS, STYLE_LABELS, describeIncludesNumber, formatStyleValue, signedFixed, whoOf, whoseOf } from './profiles';

// Inside the band the score falls linearly from 100 at the ideal to this value at the band edge,
// then from here to 0 across `tolerance` outside the band.
const EDGE_SCORE = 80;

/**
 * 0..100 closeness of `value` to a target band.
 *
 * Returns NaN when the value is null or not finite: "not measured" is not the same as "far off",
 * so callers must skip it (compareToProfile reports such dimensions with direction 'unknown' and
 * leaves them out of the overall score). The score is continuous and falls monotonically with
 * distance from the ideal on each side. A band whose ideal lies outside [low, high] is treated as
 * if the ideal were clamped to the nearest edge. With a zero-width band the only in-band value is
 * the ideal itself, so the score steps from 100 to 80 there.
 */
export function scoreDimension(value: number | null, band: TargetBand): number {
  if (value === null || !Number.isFinite(value)) return NaN;
  const low = Math.min(band.low, band.high);
  const high = Math.max(band.low, band.high);
  const ideal = Math.min(high, Math.max(low, band.ideal));
  if (value >= low && value <= high) {
    if (value === ideal) return 100;
    // value is strictly between an edge and the ideal here, so the span is positive.
    const span = value < ideal ? ideal - low : high - ideal;
    return 100 - ((100 - EDGE_SCORE) * Math.abs(value - ideal)) / span;
  }
  if (!(band.tolerance > 0)) return 0;
  const outside = value < low ? low - value : value - high;
  return EDGE_SCORE * Math.max(0, 1 - outside / band.tolerance);
}

export function directionFor(value: number | null, band: TargetBand): Direction {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value < Math.min(band.low, band.high)) return 'more';
  if (value > Math.max(band.low, band.high)) return 'less';
  return 'ok';
}

// ---------------------------------------------------------------------------------------------
// Summaries

interface SummaryWords {
  /** Relation when the value is below the band, e.g. "clearer than". */
  below: string;
  /** Relation when above the band. */
  above: string;
  /** What of the singer's we compare against, e.g. "usual tone". */
  noun: string;
}

const SUMMARY_WORDS: Record<StyleKey, SummaryWords> = {
  breathiness: { below: 'clearer than', above: 'airier than', noun: 'usual tone' },
  brightness: { below: 'warmer and darker than', above: 'brighter than', noun: 'usual tone colour' },
  rasp: { below: 'cleaner than', above: 'grittier than', noun: 'usual tone' },
  vibratoPresence: { below: 'less often than', above: 'more often than', noun: '' },
  vibratoRateHz: { below: 'slower than', above: 'faster than', noun: 'vibrato' },
  vibratoExtentCents: { below: 'narrower than', above: 'wider than', noun: 'vibrato' },
  chestInUpperRange: { below: 'less chest than', above: 'more chest than', noun: 'high notes' },
  mixInUpperRange: { below: 'less mix than', above: 'more mix than', noun: 'high notes' },
  headInUpperRange: { below: 'less falsetto than', above: 'more falsetto than', noun: 'high notes' },
  loudnessClimbDbPerSemitone: { below: 'flatter than', above: 'steeper than', noun: 'usual climb' },
  agility: { below: 'slower than', above: 'faster than', noun: 'runs' },
  dynamicRangeDb: { below: 'more even than', above: 'more contrasting than', noun: 'dynamics' },
  softOnsetRatio: { below: 'fewer airy starts than', above: 'more airy starts than', noun: 'phrases' },
  pitchAccuracyCents: { below: 'tighter than', above: 'looser than', noun: 'target' },
  flipsPerMinute: { below: 'fewer flips than', above: 'more flips than', noun: 'singing' },
};

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Quite airy (0.72)" for indices, "62% chest" for everything whose description already has the number. */
export function describeWithNumber(key: StyleKey, v: number): string {
  const d = STYLE_LABELS[key].describe(v);
  return describeIncludesNumber(key) ? d : `${d} (${formatStyleValue(key, v)})`;
}

function unmeasuredReason(key: StyleKey, analysis: VoiceAnalysis): string {
  switch (key) {
    case 'breathiness':
    case 'brightness':
    case 'rasp':
      return 'there was not enough clear, steady singing to measure the tone';
    case 'vibratoPresence':
    case 'vibratoRateHz':
    case 'vibratoExtentCents':
    case 'pitchAccuracyCents':
      return 'no notes were held long enough (about half a second or more)';
    case 'chestInUpperRange':
    case 'mixInUpperRange':
    case 'headInUpperRange':
    case 'loudnessClimbDbPerSemitone': {
      const from = midiToNoteName(analysis.passaggio.lowMidi);
      return `the take did not spend enough time above your passaggio${from ? ` (from ${from})` : ''}`;
    }
    case 'agility':
      return 'no runs were detected';
    case 'softOnsetRatio':
      return 'no clear phrase starts were detected';
    case 'dynamicRangeDb':
    case 'flipsPerMinute':
      return 'there was not enough singing to measure it';
  }
}

function summarize(
  key: StyleKey,
  value: number | null,
  band: TargetBand,
  direction: Direction,
  profile: SingerProfile,
  analysis: VoiceAnalysis,
): string {
  if (value === null || !Number.isFinite(value)) {
    return `Not measured in this take: ${unmeasuredReason(key, analysis)}.`;
  }
  const whose = whoseOf(profile);
  const heard = capitalize(describeWithNumber(key, value));

  if (key === 'pitchAccuracyCents') {
    const limit = Math.round(Math.max(band.low, band.high));
    if (direction === 'less') return `${heard}: aim for under ${limit} cents so held notes sound settled.`;
    return `${heard}: nicely in tune.`;
  }
  if (key === 'agility' && value <= 0.05 && direction === 'more') {
    return `No runs in this take; ${whoOf(profile)} tends to use short runs at about ${formatStyleValue(key, band.ideal)}.`;
  }
  if (key === 'loudnessClimbDbPerSemitone') {
    const ideal = `${signedFixed(band.ideal, 1)} dB/semitone`;
    if (direction === 'ok') return `${heard}: in line with ${whose} usual climb (about ${ideal}).`;
    const words = SUMMARY_WORDS[key];
    return `${heard}: ${direction === 'more' ? words.below : words.above} ${whose} usual climb (about ${ideal}).`;
  }

  const words = SUMMARY_WORDS[key];
  const ideal = formatStyleValue(key, band.ideal);
  if (key === 'vibratoPresence') {
    const who = whoOf(profile);
    if (direction === 'ok') return `${heard}: about as often as ${who} (around ${ideal}).`;
    return `${heard}: ${direction === 'more' ? words.below : words.above} ${who} (around ${ideal}).`;
  }
  if (direction === 'ok') return `${heard}: close to ${whose} ${words.noun} (about ${ideal}).`;
  const relation = direction === 'more' ? words.below : words.above;
  return `${heard}: ${relation} ${whose} ${words.noun} (about ${ideal}).`;
}

// ---------------------------------------------------------------------------------------------
// Range fit

const INTERVAL_NAMES = [
  'unison',
  'a half step',
  'a whole step',
  'a minor third',
  'a major third',
  'a fourth',
  'a tritone',
  'a fifth',
  'a minor sixth',
  'a major sixth',
  'a minor seventh',
  'a major seventh',
  'an octave',
];

function semitoneWords(n: number): string {
  const a = Math.abs(n);
  const count = `${a} semitone${a === 1 ? '' : 's'}`;
  return a <= 12 && a >= 1 ? `${count} (${INTERVAL_NAMES[a]})` : count;
}

function noteSpan(lo: number, hi: number): string {
  return lo === hi ? midiToNoteName(lo) : `${midiToNoteName(lo)}–${midiToNoteName(hi)}`;
}

/** Centre and span of the take's pitch, or null when the take has no usable pitch data. */
function userTessitura(analysis: VoiceAnalysis): { centre: number; span: string } | null {
  const { tessituraLowMidi: lo, tessituraHighMidi: hi, medianMidi } = analysis.pitch;
  if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi)) {
    return { centre: (lo + hi) / 2, span: noteSpan(Math.round(Math.min(lo, hi)), Math.round(Math.max(lo, hi))) };
  }
  if (medianMidi !== null && Number.isFinite(medianMidi)) {
    return { centre: medianMidi, span: `around ${midiToNoteName(medianMidi)}` };
  }
  return null;
}

function rangeFit(analysis: VoiceAnalysis, profile: SingerProfile): { transpose: number; note: string } {
  const user = userTessitura(analysis);
  const who = capitalize(whoOf(profile));
  const r = profile.typicalRange;
  const singerCentre = (r.tessituraLowMidi + r.tessituraHighMidi) / 2;
  const singerSpan = noteSpan(r.tessituraLowMidi, r.tessituraHighMidi);
  const whereSinger = profile.source === 'reference' ? `where the reference sits (${singerSpan})` : `where ${who} usually sings (${singerSpan})`;
  if (!user) {
    return {
      transpose: 0,
      note: `There was not enough pitched singing in this take to compare your range with ${whoseOf(profile)}.`,
    };
  }
  // Normalise -0 so the stored number reads cleanly.
  const transpose = Math.round(user.centre - singerCentre) || 0;
  const span = user.span.startsWith('around') ? user.span : `mostly between ${user.span.replace('–', ' and ')}`;
  const sat = `Your take sat ${span}`;
  if (Math.abs(transpose) < 3) {
    const a = Math.abs(transpose);
    const near = a === 0 ? 'close to' : `within ${a} semitone${a === 1 ? '' : 's'} of`;
    return { transpose, note: `${sat}, ${near} ${whereSinger}, so the original keys should suit you.` };
  }
  const lower = transpose < 0;
  let note =
    `${sat}, about ${semitoneWords(transpose)} ${lower ? 'lower' : 'higher'} than ${whereSinger}. ` +
    `To make these songs sit in your voice the way they sit in ${profile.source === 'reference' ? 'the reference' : `${who}'s`}, ` +
    `try them about ${Math.abs(transpose)} semitones ${lower ? 'lower' : 'higher'}.`;
  if (Math.abs(transpose) >= 10) {
    note +=
      ` That is close to an octave: if you are singing the melody an octave ${lower ? 'down' : 'up'}, the key is fine, ` +
      'but the notes land in a different part of your voice, so the register comparisons will not line up exactly.';
  }
  return { transpose, note };
}

// ---------------------------------------------------------------------------------------------

export function compareToProfile(analysis: VoiceAnalysis, profile: SingerProfile): Comparison {
  const dimensions: DimensionResult[] = [];
  let weighted = 0;
  let totalWeight = 0;
  for (const key of STYLE_KEYS) {
    const target = profile.targets[key];
    if (!target) continue;
    const raw = analysis.style[key];
    const value = raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw;
    const direction = directionFor(value, target);
    const exact = scoreDimension(value, target);
    const measured = Number.isFinite(exact);
    const weight = Number.isFinite(target.weight) ? Math.max(0, target.weight) : 0;
    if (measured) {
      weighted += weight * exact;
      totalWeight += weight;
    }
    dimensions.push({
      key,
      label: STYLE_LABELS[key].label,
      value,
      target,
      score: measured ? Math.round(exact) : 0,
      direction,
      summary: summarize(key, value, target, direction, profile, analysis),
    });
  }
  const { transpose, note } = rangeFit(analysis, profile);
  return {
    profileId: profile.id,
    overall: totalWeight > 0 ? Math.round(weighted / totalWeight) : 0,
    dimensions,
    suggestedTransposeSemitones: transpose,
    rangeNote: note,
  };
}
