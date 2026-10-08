// Scores a take's StyleVector against a singer profile and explains each dimension in plain words.

import { midiToNoteName } from '../dsp/music';
import type { Comparison, DimensionResult, Direction, SingerProfile, StyleKey, TargetBand, VoiceAnalysis } from '../types';
import {
  STYLE_KEYS,
  STYLE_LABELS,
  builtinBaseOf,
  describeIncludesNumber,
  formatStyleValue,
  signedFixed,
  whoOf,
  whoseOf,
  type ReferenceProfileExtras,
} from './profiles';

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
  loudnessClimbDbPerSemitone: { below: 'less lift than', above: 'a steeper rise than', noun: 'usual climb' },
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

/** Run speeds and flip rates at or below this read as "none" (a take or target without any is 0). */
const NONE_MAX = 0.05;

function unmeasuredReason(key: StyleKey, analysis: VoiceAnalysis): string {
  switch (key) {
    case 'breathiness':
    case 'brightness':
    case 'rasp':
      return 'there was not enough clear, steady singing to measure the tone';
    case 'vibratoRateHz':
    case 'vibratoExtentCents':
      // Held notes without any vibrato leave its speed and width unmeasured for a different reason.
      if (analysis.style.vibratoPresence === 0) return 'none of the held notes had vibrato';
      return 'no notes were held long enough (about half a second or more)';
    case 'vibratoPresence':
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
  if (key === 'agility' && band.ideal <= NONE_MAX) {
    // A target without runs (a reference clip that has none) reads "no runs", not "0.0 notes/s".
    if (value <= NONE_MAX) return `${heard}, like ${whoOf(profile)}.`;
    return direction === 'ok' ? `${heard}: close to ${whoOf(profile)}, which has no runs.` : `${heard}, where ${whoOf(profile)} has no runs.`;
  }
  if (key === 'flipsPerMinute') {
    const who = whoOf(profile);
    if (band.ideal <= NONE_MAX) {
      // Likewise a target without flips reads "none", not "about 0.0 per min".
      if (value <= NONE_MAX) return `${heard}, like ${who}.`;
      return direction === 'ok'
        ? `${heard}. ${capitalize(who)} has none, but on a take this short a single flip reaches that rate.`
        : `${heard}, where ${who} has none.`;
    }
    // On-style only because short takes get a wider band: say so rather than "close to".
    const own = profile.targets.flipsPerMinute;
    if (direction === 'ok' && own && (value < Math.min(own.low, own.high) || value > Math.max(own.low, own.high))) {
      const above = value > Math.max(own.low, own.high);
      return (
        `${heard}: ${above ? 'above' : 'below'} ${whose} usual rate (about ${formatStyleValue(key, band.ideal)}), ` +
        `but on a take this short that is only one flip ${above ? 'more' : 'fewer'}.`
      );
    }
  }
  if (key === 'loudnessClimbDbPerSemitone') {
    const ideal = `${signedFixed(band.ideal, 1)} dB/semitone`;
    if (direction === 'ok') return `${heard}: in line with ${whose} usual climb (about ${ideal}).`;
    // A falling slope is not "flatter" than a rising one; say where the singer is instead.
    if (direction === 'more' && value < 0) return `${heard}, where ${whose} usual climb is about ${ideal}.`;
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

/**
 * Low edge of each builtin singer's passaggio (where the voice changes gear), as MIDI. All three are
 * light, high-lying male voices whose mix transition sits around E4, the app's tenor zone.
 */
const SINGER_PASSAGGIO_LOW: Record<string, number> = {
  'shawn-mendes': 64,
  'daniel-caesar': 64,
  'jalen-ngonda': 64,
};

/** Voice-type key suggestions stay within a fifth either way. */
const MAX_VOICE_TYPE_SHIFT = 7;

/**
 * The passaggio low note of the singer behind a profile (a builtin, or the builtin a reference clip
 * was built on), or null when unknown. When known, key advice compares voice types instead of
 * reading one take's pitch.
 */
export function singerPassaggioLow(profile: SingerProfile): number | null {
  const chosen = referencePassaggioLow(profile);
  if (chosen !== null) return chosen;
  const base = builtinBaseOf(profile);
  return base ? (SINGER_PASSAGGIO_LOW[base.id] ?? null) : null;
}

/**
 * For a reference profile whose artist voice type the user chose ("Analyse the reference as"), the
 * passaggio low note the clip was analysed with; null otherwise (key advice then assumes the base
 * singer's voice).
 */
export function referencePassaggioLow(profile: SingerProfile): number | null {
  if (profile.source !== 'reference') return null;
  const v = (profile as SingerProfile & ReferenceProfileExtras).passaggioLowMidi;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** How key advice names what to transpose and whose voice it is compared with. */
export interface KeyAdviceNames {
  /** "Shawn's songs" / "the reference song". */
  songs: string;
  /** "Shawn's original keys" / "the reference song's original key". */
  keys: string;
  /** "Shawn's" / "the reference singer's" (whose passaggio). */
  whose: string;
}

export function keyAdviceNames(profile: SingerProfile): KeyAdviceNames {
  if (profile.source === 'reference') {
    return { songs: 'the reference song', keys: "the reference song's original key", whose: "the reference singer's" };
  }
  const who = whoOf(builtinBaseOf(profile) ?? profile);
  return { songs: `${who}'s songs`, keys: `${who}'s original keys`, whose: `${who}'s` };
}

/**
 * Whether a profile's typicalRange describes something measured. A reference clip with no
 * measurable singing has no targets, and its range is only a stand-in (the base singer's or a
 * default), so it must not be described as where the clip sits.
 */
function hasMeasuredRange(profile: SingerProfile): boolean {
  return profile.source !== 'reference' || Object.keys(profile.targets).length > 0;
}

/** "Your take sat mostly between D4 and G#4" (information only), or null without pitch data. */
function takeSentence(user: { span: string } | null): string | null {
  if (!user) return null;
  const span = user.span.startsWith('around') ? user.span : `mostly between ${user.span.replace('–', ' and ')}`;
  return `This take sat ${span}`;
}

function rangeFit(analysis: VoiceAnalysis, profile: SingerProfile): { transpose: number; note: string } {
  const user = userTessitura(analysis);
  const singerLow = singerPassaggioLow(profile);
  const userLow = analysis.passaggio?.lowMidi;
  if (singerLow !== null && typeof userLow === 'number' && Number.isFinite(userLow)) {
    return voiceTypeFit(user, userLow, singerLow, profile);
  }
  return takeFit(user, profile);
}

/**
 * Key advice from the user's voice type (their passaggio) against the singer's. A take shows what
 * was sung, not the voice's comfortable range, so its pitch is reported only as information.
 */
function voiceTypeFit(
  user: { centre: number; span: string } | null,
  userLow: number,
  singerLow: number,
  profile: SingerProfile,
): { transpose: number; note: string } {
  const { songs, keys, whose } = keyAdviceNames(profile);
  // Normalise -0 so the stored number reads cleanly.
  const transpose = Math.max(-MAX_VOICE_TYPE_SHIFT, Math.min(MAX_VOICE_TYPE_SHIFT, Math.round(userLow - singerLow))) || 0;
  const yours = midiToNoteName(userLow);
  const theirs = midiToNoteName(singerLow);
  // A reference clip's singer is compared by the voice type the user chose for it, or else assumed
  // to have the base singer's voice; say which, so the advice can be corrected.
  let basis = '';
  if (profile.source === 'reference') {
    const base = builtinBaseOf(profile);
    basis =
      referencePassaggioLow(profile) !== null
        ? ' (from the voice type you chose for the clip)'
        : base
          ? `, assuming a voice like ${whoseOf(base)} (if the artist's voice type differs, set it under "Analyse the reference as")`
          : '';
  }
  const sentences: string[] = [];
  if (transpose === 0) {
    sentences.push(
      `Based on your voice type, ${keys} should suit you: your passaggio starts around ${yours}, about where ${whose} voice changes gear${basis}.`,
    );
  } else {
    const dir = transpose < 0 ? 'lower' : 'higher';
    sentences.push(
      `Based on your voice type, ${songs} should sit best about ${semitoneWords(transpose)} ${dir}: ` +
        `your passaggio starts around ${yours}, and ${whose} voice changes gear around ${theirs}${basis}.`,
    );
  }
  const sat = takeSentence(user);
  if (sat) {
    let info = sat;
    if (profile.source === 'reference' && user && hasMeasuredRange(profile)) {
      // The clip's own range: useful if the user sang the same song, as information only.
      const r = profile.typicalRange;
      const diff = Math.round(user.centre - (r.tessituraLowMidi + r.tessituraHighMidi) / 2);
      const clip = noteSpan(r.tessituraLowMidi, r.tessituraHighMidi);
      info +=
        Math.abs(diff) < 1
          ? `, about where the reference clip sits (${clip})`
          : `, about ${semitoneWords(diff)} ${diff < 0 ? 'below' : 'above'} the reference clip (${clip})`;
    }
    sentences.push(`${info}; that reflects what you sang, not your whole range.`);
  }
  return { transpose, note: sentences.join(' ') };
}

/**
 * Without a known singer passaggio (a reference clip with no builtin behind it), the only basis is
 * this take against the clip. It is reported as information, not as key advice.
 */
function takeFit(user: { centre: number; span: string } | null, profile: SingerProfile): { transpose: number; note: string } {
  const r = profile.typicalRange;
  const singerCentre = (r.tessituraLowMidi + r.tessituraHighMidi) / 2;
  const singerSpan = noteSpan(r.tessituraLowMidi, r.tessituraHighMidi);
  const whereSinger = profile.source === 'reference' ? `the reference clip (${singerSpan})` : `where ${capitalize(whoOf(profile))} usually sings (${singerSpan})`;
  const sat = takeSentence(user);
  if (!hasMeasuredRange(profile)) {
    return { transpose: 0, note: 'There was not enough singing in the reference clip to compare ranges with it.' };
  }
  if (!user || !sat) {
    return {
      transpose: 0,
      note: `There was not enough pitched singing in this take to compare your range with ${whoseOf(profile)}.`,
    };
  }
  // Normalise -0 so the stored number reads cleanly.
  const transpose = Math.round(user.centre - singerCentre) || 0;
  if (Math.abs(transpose) < 1) return { transpose, note: `${sat}, about the same as ${whereSinger}.` };
  let note =
    `${sat}, about ${semitoneWords(transpose)} ${transpose < 0 ? 'lower' : 'higher'} than ${whereSinger}. ` +
    'If you sang the same song, that is how far your key was from the original; a single take shows what you sang, not your whole range.';
  if (Math.abs(transpose) >= 10) {
    note += ' That is close to an octave, so the notes land in a different part of your voice and the register comparisons will not line up exactly.';
  }
  return { transpose, note };
}

// ---------------------------------------------------------------------------------------------
// Short takes and scoreability

/** Below this much singing, one flip moves the per-minute rate by more than a flips band is wide. */
const FLIP_RATE_STABLE_SEC = 60;

/**
 * The band a dimension is scored against for this take. A take with `v` seconds of singing can only
 * report multiples of 60/v flips per minute, so on takes under a minute the flips band is widened by
 * one such step each way: one flip more or fewer than the singer's rate then still counts as on-style.
 */
function bandForTake(key: StyleKey, target: TargetBand, analysis: VoiceAnalysis): TargetBand {
  const sec = analysis.voicedSec;
  if (key !== 'flipsPerMinute' || !(sec > 0) || sec >= FLIP_RATE_STABLE_SEC) return target;
  const step = 60 / sec;
  return { ...target, low: Math.max(0, Math.min(target.low, target.high) - step), high: Math.max(target.low, target.high) + step };
}

/** Fewer measured dimensions than this and a match score says more about the gaps than the voice. */
const MIN_SCOREABLE_DIMENSIONS = 4;

/**
 * Whether a take can be scored at all: false when it has too little singing, sounds like singing
 * over instruments, or (given a comparison) measured fewer than four of the profile's dimensions.
 * Unscoreable takes get a re-record plan instead of a score and should not be saved as progress.
 */
export function isScoreable(analysis: VoiceAnalysis, comparison?: Comparison): boolean {
  const issues = analysis.issues ?? [];
  if (issues.includes('too-little-singing') || issues.includes('accompaniment')) return false;
  // A full-song reading carries no tone measures: never a score against a singer's tone targets, whatever its issue list says.
  if (analysis.mode === 'mix') return false;
  if (comparison && comparison.dimensions.filter((d) => d.value !== null).length < MIN_SCOREABLE_DIMENSIONS) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------

export function compareToProfile(analysis: VoiceAnalysis, profile: SingerProfile): Comparison {
  const dimensions: DimensionResult[] = [];
  let weighted = 0;
  let totalWeight = 0;
  for (const key of STYLE_KEYS) {
    const authored = profile.targets[key];
    if (!authored) continue;
    const target = bandForTake(key, authored, analysis);
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
