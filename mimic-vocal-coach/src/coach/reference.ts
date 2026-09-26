// Reference-clip mode: the user uploads a clip of the artist from their own library. We can
// (1) turn the clip's measured StyleVector into a SingerProfile, so the normal scoring and coaching
// run against the real recording instead of a hand-authored estimate, and (2) align the user's
// pitch contour with the reference, key-shift-invariantly, and compare phrase by phrase.

import { clamp, linearRegression, mean, median, std } from '../dsp/stats';
import { midiToNoteName } from '../dsp/music';
import type {
  Phrase,
  ReferenceComparison,
  ReferenceSegmentComparison,
  SingerProfile,
  StyleKey,
  StyleVector,
  TargetBand,
  VoiceAnalysis,
  VoiceType,
} from '../types';
import type { ReferenceProfileExtras } from './profiles';

const STYLE_KEYS: StyleKey[] = [
  'breathiness',
  'brightness',
  'rasp',
  'vibratoPresence',
  'vibratoRateHz',
  'vibratoExtentCents',
  'chestInUpperRange',
  'mixInUpperRange',
  'headInUpperRange',
  'loudnessClimbDbPerSemitone',
  'agility',
  'dynamicRangeDb',
  'softOnsetRatio',
  'pitchAccuracyCents',
  'flipsPerMinute',
];

export const REFERENCE_PROFILE_COLOR = '#50606f';

// ---------------------------------------------------------------------------------------------
// profileFromReference

interface BandSpec {
  /** Half-width of the on-style band around the measured value, in the dimension's own units. */
  halfWidth: number;
  /** Distance outside the band at which the score reaches ~0 (same meaning as TargetBand.tolerance). */
  tolerance: number;
  /** Default importance when no base profile supplies one. */
  weight: number;
  /** Physical limits of the dimension; band edges are clamped into them. */
  min?: number;
  max?: number;
}

// Band widths are judgement calls, not measurements: they approximate how much each measure moves
// between phrases of one singer singing in one style (so a user inside the band is as close as the
// singer is to themself), and are deliberately wider for measures that rest on few events (vibrato
// rate/extent, flips, runs). Tolerances match the scale used by the hand-authored profiles, e.g.
// 0.3 on 0..1 tone indices and 25 cents on pitch accuracy.
const BAND_SPECS: Record<StyleKey, BandSpec> = {
  breathiness: { halfWidth: 0.1, tolerance: 0.3, weight: 0.8, min: 0, max: 1 },
  brightness: { halfWidth: 0.1, tolerance: 0.3, weight: 0.7, min: 0, max: 1 },
  rasp: { halfWidth: 0.08, tolerance: 0.25, weight: 0.5, min: 0, max: 1 },
  vibratoPresence: { halfWidth: 0.15, tolerance: 0.4, weight: 0.5, min: 0, max: 1 },
  vibratoRateHz: { halfWidth: 0.5, tolerance: 1.5, weight: 0.3, min: 0 },
  vibratoExtentCents: { halfWidth: 15, tolerance: 40, weight: 0.4, min: 0 },
  chestInUpperRange: { halfWidth: 0.12, tolerance: 0.35, weight: 0.7, min: 0, max: 1 },
  mixInUpperRange: { halfWidth: 0.12, tolerance: 0.35, weight: 1, min: 0, max: 1 },
  headInUpperRange: { halfWidth: 0.12, tolerance: 0.35, weight: 0.7, min: 0, max: 1 },
  loudnessClimbDbPerSemitone: { halfWidth: 0.3, tolerance: 1, weight: 0.6 },
  agility: { halfWidth: 1.5, tolerance: 4, weight: 0.3, min: 0 },
  dynamicRangeDb: { halfWidth: 4, tolerance: 10, weight: 0.3, min: 0 },
  softOnsetRatio: { halfWidth: 0.15, tolerance: 0.4, weight: 0.5, min: 0, max: 1 },
  pitchAccuracyCents: { halfWidth: 5, tolerance: 25, weight: 0.5, min: 0 },
  flipsPerMinute: { halfWidth: 1, tolerance: 3, weight: 0.4, min: 0 },
};

// Released vocals are often pitch-corrected, so the clip's own accuracy is not a fair target;
// every reference profile asks for the same "clean" band instead.
const PITCH_ACCURACY_TARGET = { ideal: 5, low: 0, high: 15 };

const DEFAULT_TYPICAL_RANGE = { lowMidi: 48, highMidi: 72, tessituraLowMidi: 55, tessituraHighMidi: 67 };

function bandAround(key: StyleKey, value: number, weight: number): TargetBand {
  const spec = BAND_SPECS[key];
  const lo = spec.min ?? -Infinity;
  const hi = spec.max ?? Infinity;
  const ideal = clamp(value, lo, hi);
  return {
    ideal,
    low: clamp(ideal - spec.halfWidth, lo, hi),
    high: clamp(ideal + spec.halfWidth, lo, hi),
    tolerance: spec.tolerance,
    weight,
  };
}

// Safety limits, matching the builtin profiles and the coach's health notes. A full mix (drums,
// distorted guitars, a louder chorus arrangement) inflates rasp, chest share and loudness climb, and
// even a clean clip can belt harder than is healthy to copy, so the targets never ask for grit,
// heavy chest above the passaggio or a climb the health notes call pushing.
/** Rasp: a clean tone is always on-style and the ideal is at most "slight grit". */
const MAX_RASP_IDEAL = 0.15;
/** Rasp above this reads as noticeable; the health notes warn about it. */
const MAX_RASP_HIGH = 0.4;
/** Chest share above the passaggio: the health notes call more than 0.6 heavy. */
const MAX_CHEST_IDEAL = 0.55;
const MAX_CHEST_HIGH = 0.6;
const MAX_CHEST_LOW = 0.45;
/** Loudness climb, dB/semitone: more than 0.8 reads as pushing chest weight up. */
const MAX_CLIMB_IDEAL = 0.5;
const MAX_CLIMB_HIGH = 0.8;

function safeBand(key: StyleKey, band: TargetBand, value: number): TargetBand {
  switch (key) {
    case 'rasp': {
      const ideal = Math.min(band.ideal, MAX_RASP_IDEAL);
      return { ...band, ideal, low: 0, high: clamp(value + BAND_SPECS.rasp.halfWidth, 0.2, MAX_RASP_HIGH) };
    }
    case 'chestInUpperRange': {
      const ideal = Math.min(band.ideal, MAX_CHEST_IDEAL);
      const half = BAND_SPECS.chestInUpperRange.halfWidth;
      return { ...band, ideal, low: Math.max(0, Math.min(ideal - half, MAX_CHEST_LOW)), high: Math.min(ideal + half, MAX_CHEST_HIGH) };
    }
    case 'loudnessClimbDbPerSemitone': {
      // A level climb is always on-style, as in every builtin profile.
      const ideal = Math.min(band.ideal, MAX_CLIMB_IDEAL);
      const half = BAND_SPECS.loudnessClimbDbPerSemitone.halfWidth;
      return { ...band, ideal, low: Math.min(ideal - half, 0), high: Math.max(0, Math.min(ideal + half, MAX_CLIMB_HIGH)) };
    }
    default:
      return band;
  }
}

function targetsFromStyle(style: StyleVector, base?: SingerProfile): Partial<Record<StyleKey, TargetBand>> {
  const targets: Partial<Record<StyleKey, TargetBand>> = {};
  const weightOf = (key: StyleKey): number => base?.targets[key]?.weight ?? BAND_SPECS[key].weight;
  for (const key of STYLE_KEYS) {
    if (key === 'pitchAccuracyCents') continue;
    const value = style[key];
    if (value === null || !Number.isFinite(value)) continue;
    // A short clip without runs says little about whether the singer does runs, so a measured
    // agility of 0 only counts half as much as a positive measurement.
    const w = key === 'agility' && value === 0 ? weightOf(key) / 2 : weightOf(key);
    targets[key] = safeBand(key, bandAround(key, value, w), value);
  }
  // Chest weight the targets won't ask for goes to mix, the healthy way to keep strength up high,
  // so the three register targets still describe one coherent sound.
  const chest = style.chestInUpperRange;
  const mix = style.mixInUpperRange;
  if (chest !== null && mix !== null && chest > MAX_CHEST_IDEAL && targets.mixInUpperRange) {
    targets.mixInUpperRange = bandAround('mixInUpperRange', Math.min(1, mix + (chest - MAX_CHEST_IDEAL)), targets.mixInUpperRange.weight);
  }
  // Tuning is always targeted at the clean band (see PITCH_ACCURACY_TARGET), but only when the clip
  // had held notes to measure and something else was measured too, so a profile can never rest on
  // this one target alone (a clip with no clear singing would otherwise score every take ~90).
  const pitch = style.pitchAccuracyCents;
  if (pitch !== null && Number.isFinite(pitch) && Object.keys(targets).length > 0) {
    targets.pitchAccuracyCents = { ...PITCH_ACCURACY_TARGET, tolerance: BAND_SPECS.pitchAccuracyCents.tolerance, weight: weightOf('pitchAccuracyCents') };
  }
  return targets;
}

function typicalRangeFrom(ref: VoiceAnalysis, base?: SingerProfile): SingerProfile['typicalRange'] {
  const p = ref.pitch;
  if (p.lowMidi !== null && p.highMidi !== null && p.tessituraLowMidi !== null && p.tessituraHighMidi !== null) {
    return { lowMidi: p.lowMidi, highMidi: p.highMidi, tessituraLowMidi: p.tessituraLowMidi, tessituraHighMidi: p.tessituraHighMidi };
  }
  return base ? { ...base.typicalRange } : { ...DEFAULT_TYPICAL_RANGE };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fixed = (x: number, digits: number): string => x.toFixed(digits);

// Word choices follow the anchor meanings documented on StyleVector in types.ts.
function breathinessWords(v: number): string {
  // A low index alone means a clean, firm tone; it is not evidence of pressed phonation.
  if (v < 0.25) return 'very clean and firm';
  if (v < 0.55) return 'clear, balanced';
  if (v < 0.85) return 'noticeably airy';
  return 'near-whisper, very breathy';
}

function brightnessWords(v: number): string {
  if (v < 0.35) return 'dark, warm';
  if (v < 0.65) return 'neutral';
  return 'bright, forward';
}

function raspWords(v: number): string {
  if (v < 0.18) return 'little or no grit';
  if (v < 0.45) return 'a touch of grit on louder notes';
  return 'obvious rasp';
}

function dominantUpperRegister(style: StyleVector): string | null {
  const shares: [string, number | null][] = [
    ['chest', style.chestInUpperRange],
    ['mix', style.mixInUpperRange],
    ['head voice', style.headInUpperRange],
  ];
  let best: [string, number] | null = null;
  for (const [name, v] of shares) if (v !== null && (best === null || v > best[1])) best = [name, v];
  return best ? best[0] : null;
}

function vibratoTrait(style: StyleVector): string | null {
  const presence = style.vibratoPresence;
  if (presence === null) return null;
  if (presence < 0.2) return `Mostly straight tone on held notes (vibrato on ${pct(presence)} of them)`;
  let s = `Vibrato on about ${pct(presence)} of held notes`;
  const details: string[] = [];
  if (style.vibratoRateHz !== null) details.push(`around ${fixed(style.vibratoRateHz, 1)} Hz`);
  if (style.vibratoExtentCents !== null) details.push(`about ±${Math.round(style.vibratoExtentCents)} cents wide`);
  if (details.length) s += `, ${details.join(', ')}`;
  return s;
}

function loudnessClimbTrait(v: number): string {
  const n = `${v >= 0 ? '+' : ''}${fixed(v, 1)} dB per semitone`;
  if (v > 0.8) return `Gets louder as the line climbs (${n}), carrying weight upward`;
  if (v < 0.3) return `Stays level in volume while climbing (${n})`;
  return `Adds a little volume as the line climbs (${n})`;
}

/** Plain-English traits for a measured StyleVector; skips anything that was not measured. */
export function describeStyleTraits(style: StyleVector): string[] {
  const traits: string[] = [];
  if (style.breathiness !== null) traits.push(`${cap(breathinessWords(style.breathiness))} tone (breathiness ${fixed(style.breathiness, 2)})`);
  if (style.brightness !== null) traits.push(`${cap(brightnessWords(style.brightness))} colour (brightness ${fixed(style.brightness, 2)})`);
  if (style.rasp !== null) traits.push(`${cap(raspWords(style.rasp))} (rasp ${fixed(style.rasp, 2)})`);
  const { chestInUpperRange: c, mixInUpperRange: m, headInUpperRange: h } = style;
  if (c !== null && m !== null && h !== null) {
    traits.push(`Above the passaggio: about ${pct(c)} chest, ${pct(m)} mix, ${pct(h)} head (acoustic estimates)`);
  }
  if (style.loudnessClimbDbPerSemitone !== null) traits.push(loudnessClimbTrait(style.loudnessClimbDbPerSemitone));
  const vib = vibratoTrait(style);
  if (vib) traits.push(vib);
  if (style.agility !== null && style.agility > 0) traits.push(`Runs at about ${fixed(style.agility, 1)} notes per second`);
  if (style.softOnsetRatio !== null) traits.push(`${cap(pct(style.softOnsetRatio))} of phrases start with a soft, breathy onset`);
  if (style.flipsPerMinute !== null && style.flipsPerMinute >= 0.5) {
    traits.push(`Flips into head voice about ${fixed(style.flipsPerMinute, 1)} times a minute`);
  }
  if (style.dynamicRangeDb !== null) traits.push(`Loudness range of about ${Math.round(style.dynamicRangeDb)} dB`);
  return traits;
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function describeReference(ref: VoiceAnalysis): string {
  const s = ref.style;
  const parts: string[] = [];
  const tone: string[] = [];
  if (s.breathiness !== null) tone.push(`a ${breathinessWords(s.breathiness)} tone`);
  if (s.brightness !== null) tone.push(`a ${brightnessWords(s.brightness)} colour`);
  let first = 'Measured from the reference clip you uploaded';
  if (tone.length) first += `: ${tone.join(' with ')}`;
  if (s.rasp !== null) first += `${tone.length ? ' and ' : ': '}${raspWords(s.rasp)}`;
  parts.push(`${first}.`);
  const dominant = dominantUpperRegister(s);
  if (dominant) parts.push(`Above the passaggio it reads mostly as ${dominant} (an acoustic estimate).`);
  const { lowMidi, highMidi } = ref.pitch;
  if (lowMidi !== null && highMidi !== null) {
    parts.push(`The clip spans roughly ${midiToNoteName(lowMidi)} to ${midiToNoteName(highMidi)}.`);
  }
  parts.push('These targets are only as reliable as the recording they came from.');
  return parts.join(' ');
}

function sourceNoteFor(ref: VoiceAnalysis): string {
  let note =
    `Measured from the reference clip you uploaded (${Math.round(ref.voicedSec)} s of singing), not hand-authored. ` +
    'The analysis assumes a single voice: instruments, backing vocals, reverb and other effects in a full mix ' +
    'lower the reliability of every measurement, so an isolated vocal (a stem or an a cappella passage) works best. ' +
    'Pitch accuracy is always targeted at 0-15 cents because released vocals are often pitch-corrected.';
  if (ref.voicedSec < 15) note += ' With under 15 s of singing, some targets are rough.';
  if (ref.warnings.length) note += ` The clip was flagged: ${ref.warnings.join(' ')}`;
  return note;
}

/** Seconds of singing below which a reference clip can't give reliable targets. */
const MIN_REFERENCE_VOICED_SEC = 5;

/**
 * Whether a reference clip can be used as a target, and if not, why, in plain English that names the
 * fix. Unusable: under 5 s of singing, singing over instruments (a full song mix), or mostly
 * speech-like syllables.
 */
export function referenceUsability(ref: VoiceAnalysis): { usable: boolean; reason: string | null } {
  const issues = ref.issues ?? [];
  const voiced = Number.isFinite(ref.voicedSec) ? Math.max(0, ref.voicedSec) : 0;
  if (issues.includes('accompaniment')) {
    return {
      usable: false,
      reason:
        'This clip sounds like a full song mix, so the analysis would follow the instruments or the bass rather than the voice. ' +
        'Use an isolated vocal (a vocal stem) or an a cappella section instead.',
    };
  }
  if (issues.includes('too-little-singing') || voiced < MIN_REFERENCE_VOICED_SEC) {
    const heard =
      voiced < 0.5
        ? 'No clear singing could be measured in this clip'
        : `Only ${voiced < 10 ? voiced.toFixed(1) : Math.round(voiced)} s of clear singing could be measured in this clip`;
    return {
      usable: false,
      reason:
        `${heard}, which is too little to build targets from; backing music or effects may be covering the voice. ` +
        'Use an isolated vocal or an a cappella section with at least 10 seconds of singing.',
    };
  }
  if (issues.includes('speech-like')) {
    return {
      usable: false,
      reason:
        'This clip sounds mostly like short, speech-like syllables with few held notes, so it can\'t give reliable singing targets. ' +
        'Use a sung section with some held notes, ideally an isolated vocal or an a cappella passage.',
    };
  }
  return { usable: true, reason: null };
}

export interface ReferenceProfileOptions {
  /**
   * The artist's voice type as the user chose it under "Analyse the reference as" (null or absent
   * when left at the user's own voice type). When set, key advice compares the user's passaggio with
   * the one the clip was analysed with (`ref.passaggio`) instead of assuming the base singer's voice.
   */
  artistVoiceType?: VoiceType | null;
}

/** Build a SingerProfile whose targets are centred on a reference clip's measured StyleVector. */
export function profileFromReference(
  ref: VoiceAnalysis,
  name: string,
  base?: SingerProfile,
  opts?: ReferenceProfileOptions,
): SingerProfile & ReferenceProfileExtras {
  const low = ref.passaggio?.lowMidi;
  const extras: ReferenceProfileExtras = opts?.artistVoiceType && typeof low === 'number' && Number.isFinite(low) ? { passaggioLowMidi: low } : {};
  return {
    ...extras,
    id: 'reference',
    name,
    tagline: 'Targets measured from your own reference clip',
    description: describeReference(ref),
    traits: describeStyleTraits(ref.style),
    studySongs: base ? base.studySongs.map((s) => ({ ...s })) : [],
    typicalRange: typicalRangeFrom(ref, base),
    targets: targetsFromStyle(ref.style, base),
    signatureMoves: base ? base.signatureMoves.map((m) => ({ ...m, howTo: [...m.howTo] })) : [],
    color: base ? base.color : REFERENCE_PROFILE_COLOR,
    source: 'reference',
    sourceNote: sourceNoteFor(ref),
  };
}

// ---------------------------------------------------------------------------------------------
// compareToReference

/** A voiced-only pitch contour on a coarse grid. */
interface Contour {
  t: Float64Array;
  midi: Float64Array;
}

/** Wrong notes cost at most this much (semitones) per step so one bad note can't steer the alignment. */
const COST_CAP_SEMITONES = 3;
/** Small cost for non-diagonal steps: keeps the path diagonal through held notes where any warp is free. */
const STEP_PENALTY = 0.05;
/** Reported cents differences are clamped to the same cap: beyond it, it is simply "a different note". */
const CENTS_CAP = COST_CAP_SEMITONES * 100;
const MIN_GRID_SEC = 0.04;
/** DTW cell budgets. The final pass stores one byte per cell for backtracking (12 MB at most). */
const MAX_CELLS_FINAL = 12e6;
const MAX_CELLS_SEARCH = 2.5e6;
const MAX_PATH_POINTS = 1500;
const MIN_SEGMENT_PAIRS = 3;
const FALLBACK_WINDOW_SEC = 5;
/** Local transposition search stops this far from the median-based estimate. */
const MAX_LOCAL_SHIFT = 4;
/** Relative tempo differences below this (8%) are not worth mentioning. */
const TEMPO_TOLERANCE = 1.08;

function voicedFrameCount(a: VoiceAnalysis): number {
  let n = 0;
  for (const f of a.frames) if (f.voiced && Number.isFinite(f.midi)) n++;
  return n;
}

/** Grid step so that an n x m DTW over both contours stays within `maxCells`. */
function gridStep(a: VoiceAnalysis, b: VoiceAnalysis, maxCells: number): number {
  const secA = voicedFrameCount(a) * a.hopSec;
  const secB = voicedFrameCount(b) * b.hopSec;
  return Math.max(MIN_GRID_SEC, Math.sqrt((secA * secB) / maxCells));
}

/**
 * Median-pools voiced frames into bins of `step` seconds. A bin is kept only if at least half of
 * its frames are voiced, so breaths and consonants don't leave half-empty, jittery points.
 * The median resists the odd octave glitch from the pitch tracker.
 */
function pooledContour(a: VoiceAnalysis, step: number): Contour {
  const ts: number[] = [];
  const ms: number[] = [];
  let bin = -1;
  let frameCount = 0;
  let vals: number[] = [];
  let times: number[] = [];
  const flush = (): void => {
    if (vals.length > 0 && vals.length * 2 >= frameCount) {
      ts.push(mean(times));
      ms.push(median(vals));
    }
  };
  for (const f of a.frames) {
    const b = Math.floor(f.t / step);
    if (b !== bin) {
      flush();
      bin = b;
      frameCount = 0;
      vals = [];
      times = [];
    }
    frameCount++;
    if (f.voiced && Number.isFinite(f.midi)) {
      vals.push(f.midi);
      times.push(f.t);
    }
  }
  flush();
  return { t: Float64Array.from(ts), midi: Float64Array.from(ms) };
}

/**
 * Pooled contours of both takes on the finest grid whose DTW fits `maxCells`. The first step is
 * estimated from voiced durations; bins that are only partly voiced can make the contours longer
 * than that estimate, so the step is widened until the product fits.
 */
function contoursWithin(user: VoiceAnalysis, ref: VoiceAnalysis, maxCells: number): { step: number; user: Contour; ref: Contour } {
  let step = gridStep(user, ref, maxCells);
  for (let attempt = 0; ; attempt++) {
    const u = pooledContour(user, step);
    const r = pooledContour(ref, step);
    const cells = u.midi.length * r.midi.length;
    if (cells <= maxCells * 1.25 || attempt === 3) return { step, user: u, ref: r };
    step *= Math.sqrt(cells / maxCells);
  }
}

function shifted(c: Contour, semitones: number): Contour {
  const midi = new Float64Array(c.midi.length);
  for (let i = 0; i < midi.length; i++) midi[i] = c.midi[i] + semitones;
  return { t: c.t, midi };
}

function localCost(a: number, b: number): number {
  const d = a > b ? a - b : b - a;
  return d < COST_CAP_SEMITONES ? d : COST_CAP_SEMITONES;
}

/**
 * Subsequence DTW cost: every query point is aligned, while the path may start and end anywhere in
 * the target. This lets a user who sang one verse align against a whole-song reference (and vice
 * versa, since the shorter contour is always the query). Steps: diagonal, or one step along either
 * axis with STEP_PENALTY. Memory is two rows.
 */
function subsequenceDtwCost(q: Float64Array, tg: Float64Array): number {
  const n = q.length;
  const m = tg.length;
  let prev = new Float64Array(m);
  let cur = new Float64Array(m);
  for (let j = 0; j < m; j++) prev[j] = localCost(q[0], tg[j]);
  for (let i = 1; i < n; i++) {
    const qi = q[i];
    cur[0] = prev[0] + STEP_PENALTY + localCost(qi, tg[0]);
    for (let j = 1; j < m; j++) {
      const diag = prev[j - 1];
      const up = prev[j] + STEP_PENALTY;
      const left = cur[j - 1] + STEP_PENALTY;
      let best = diag < up ? diag : up;
      if (left < best) best = left;
      cur[j] = best + localCost(qi, tg[j]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let min = Infinity;
  for (let j = 0; j < m; j++) if (prev[j] < min) min = prev[j];
  return min;
}

const DIR_DIAG = 0;
const DIR_UP = 1; // from (i-1, j)
const DIR_LEFT = 2; // from (i, j-1)
const DIR_START = 3;

/** Same recurrence as subsequenceDtwCost, with backtracking. Returns [queryIndex, targetIndex] pairs in order. */
function subsequenceDtwPath(q: Float64Array, tg: Float64Array): [number, number][] {
  const n = q.length;
  const m = tg.length;
  const dir = new Uint8Array(n * m);
  let prev = new Float64Array(m);
  let cur = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    prev[j] = localCost(q[0], tg[j]);
    dir[j] = DIR_START;
  }
  for (let i = 1; i < n; i++) {
    const qi = q[i];
    const row = i * m;
    cur[0] = prev[0] + STEP_PENALTY + localCost(qi, tg[0]);
    dir[row] = DIR_UP;
    for (let j = 1; j < m; j++) {
      const diag = prev[j - 1];
      const up = prev[j] + STEP_PENALTY;
      const left = cur[j - 1] + STEP_PENALTY;
      let best = diag;
      let d = DIR_DIAG;
      if (up < best) {
        best = up;
        d = DIR_UP;
      }
      if (left < best) {
        best = left;
        d = DIR_LEFT;
      }
      cur[j] = best + localCost(qi, tg[j]);
      dir[row + j] = d;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let j = 0;
  for (let k = 1; k < m; k++) if (prev[k] < prev[j]) j = k;
  let i = n - 1;
  const path: [number, number][] = [];
  for (;;) {
    path.push([i, j]);
    const d = dir[i * m + j];
    if (d === DIR_START) break;
    if (d === DIR_DIAG) {
      i--;
      j--;
    } else if (d === DIR_UP) i--;
    else j--;
  }
  path.reverse();
  return path;
}

/** DTW cost of aligning user and reference with the reference moved by `shift` semitones. */
function alignmentCost(user: Contour, ref: Contour, shift: number): number {
  const r = shifted(ref, shift);
  return user.midi.length <= r.midi.length ? subsequenceDtwCost(user.midi, r.midi) : subsequenceDtwCost(r.midi, user.midi);
}

/**
 * Integer transposition (user minus reference). Start from the median pitch difference, walk to the
 * locally cheapest shift (the median is biased when the user sang only part of the reference or
 * ornamented differently), then test the octave either side, which the median can't separate from
 * a register choice.
 */
function estimateTranspose(user: Contour, ref: Contour): number {
  const m0 = Math.round(median(user.midi) - median(ref.midi));
  const costs = new Map<number, number>();
  const cost = (s: number): number => {
    let c = costs.get(s);
    if (c === undefined) {
      c = alignmentCost(user, ref, s);
      costs.set(s, c);
    }
    return c;
  };
  let best = m0;
  for (const s of [m0 - 1, m0 + 1]) if (cost(s) < cost(best)) best = s;
  // Keep walking while the cheapest shift is at the edge of what has been evaluated.
  while (Math.abs(best - m0) < MAX_LOCAL_SHIFT) {
    const next = best + Math.sign(best - m0);
    if (next === best || cost(next) >= cost(best)) break;
    best = next;
  }
  for (const s of [best - 12, best + 12]) if (cost(s) < cost(best)) best = s;
  return best;
}

interface AlignedPair {
  userT: number;
  refT: number;
  cents: number;
}

function alignedPairs(user: Contour, ref: Contour, shift: number): AlignedPair[] {
  const r = shifted(ref, shift);
  const userIsQuery = user.midi.length <= r.midi.length;
  const path = userIsQuery ? subsequenceDtwPath(user.midi, r.midi) : subsequenceDtwPath(r.midi, user.midi);
  return path.map(([qi, ti]) => {
    const ui = userIsQuery ? qi : ti;
    const ri = userIsQuery ? ti : qi;
    const cents = clamp((user.midi[ui] - r.midi[ri]) * 100, -CENTS_CAP, CENTS_CAP);
    return { userT: user.t[ui], refT: ref.t[ri], cents };
  });
}

function decimate<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(xs[Math.round((k * (xs.length - 1)) / (max - 1))]);
  return out;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function segmentWindows(ref: VoiceAnalysis, pairs: AlignedPair[]): Phrase[] {
  if (ref.phrases.length > 0) return ref.phrases;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pairs) {
    if (p.refT < lo) lo = p.refT;
    if (p.refT > hi) hi = p.refT;
  }
  const out: Phrase[] = [];
  for (let s = Math.max(0, lo); s < hi; s += FALLBACK_WINDOW_SEC) out.push({ start: s, end: Math.min(hi, s + FALLBACK_WINDOW_SEC) });
  if (out.length === 0 && Number.isFinite(lo)) out.push({ start: lo, end: hi });
  return out;
}

function pitchSentence(meanAbs: number, meanSigned: number, within50: number, spread: number): string {
  const bias = Math.round(Math.abs(meanSigned));
  const biasWord = meanSigned < 0 ? 'flat' : 'sharp';
  // A large spread around the reference line means different notes or ornaments, not a tuning bias.
  if (within50 < 0.6 || spread > 60) {
    let s = `The melody or ornaments differ from the reference here: only ${pct(within50)} of the phrase was within 50 cents of it, so check the notes and any runs against the original.`;
    if (bias >= 15) s += ` On average you sat ${bias} cents ${biasWord}.`;
    return s;
  }
  if (bias >= 15) return `About ${bias} cents ${biasWord} of the reference on this phrase.`;
  return `On pitch with the reference (about ${Math.round(meanAbs)} cents off on average).`;
}

function timingSentence(slope: number): string | null {
  if (!Number.isFinite(slope) || slope <= 0) return null;
  if (slope > TEMPO_TOLERANCE) {
    return `You took about ${Math.round((slope - 1) * 100)}% longer than the reference, so you were falling behind its timing.`;
  }
  if (slope < 1 / TEMPO_TOLERANCE) {
    return `You got through it about ${Math.round((1 - slope) * 100)}% faster than the reference, so you were ahead of its timing.`;
  }
  return null;
}

function compareSegment(window: Phrase, pairs: AlignedPair[], step: number, user: VoiceAnalysis): ReferenceSegmentComparison | null {
  const eps = step / 2;
  const inside = pairs.filter((p) => p.refT >= window.start - eps && p.refT <= window.end + eps);
  if (inside.length < MIN_SEGMENT_PAIRS) return null;
  const cents = inside.map((p) => p.cents);
  const meanAbs = mean(cents.map(Math.abs));
  const meanSigned = mean(cents);
  const within50 = cents.filter((c) => Math.abs(c) <= 50).length / cents.length;
  const spread = std(cents);
  let uLo = Infinity;
  let uHi = -Infinity;
  let rLo = Infinity;
  let rHi = -Infinity;
  for (const p of inside) {
    uLo = Math.min(uLo, p.userT);
    uHi = Math.max(uHi, p.userT);
    rLo = Math.min(rLo, p.refT);
    rHi = Math.max(rHi, p.refT);
  }
  const notes = [pitchSentence(meanAbs, meanSigned, within50, spread)];
  // Tempo only means something over a stretch long enough to contain a few notes.
  if (rHi - rLo >= 1 && inside.length >= 8) {
    const { slope } = linearRegression(
      inside.map((p) => p.refT),
      inside.map((p) => p.userT),
    );
    const timing = timingSentence(slope);
    if (timing) notes.push(timing);
  }
  return {
    refStart: round3(Math.max(window.start, rLo - eps)),
    refEnd: round3(Math.min(window.end, rHi + eps)),
    userStart: round3(Math.max(0, uLo - eps)),
    userEnd: round3(Math.min(user.durationSec, uHi + eps)),
    meanAbsCents: round1(meanAbs),
    meanSignedCents: round1(meanSigned),
    note: notes.join(' '),
  };
}

function styleDifference(user: StyleVector, ref: StyleVector): Partial<Record<StyleKey, number>> {
  const diff: Partial<Record<StyleKey, number>> = {};
  for (const key of STYLE_KEYS) {
    const u = user[key];
    const r = ref[key];
    if (u !== null && r !== null && Number.isFinite(u) && Number.isFinite(r)) diff[key] = u - r;
  }
  return diff;
}

/** Fewer aligned grid points than this and the comparison is not meaningful. */
const MIN_CONTOUR_POINTS = 10;

/**
 * Align the user's pitch contour to the reference (key-shift-invariant DTW) and compare phrase by phrase.
 * If either take has too little voiced material, returns an empty `path` and `segments`, with
 * `meanAbsCents` NaN and `withinFiftyCents` 0.
 */
export function compareToReference(user: VoiceAnalysis, ref: VoiceAnalysis): ReferenceComparison {
  const styleDiff = styleDifference(user.style, ref.style);
  const { step, user: userC, ref: refC } = contoursWithin(user, ref, MAX_CELLS_FINAL);
  if (userC.midi.length < MIN_CONTOUR_POINTS || refC.midi.length < MIN_CONTOUR_POINTS) {
    const guess = Math.round(median(userC.midi) - median(refC.midi));
    return {
      transposeSemitones: Number.isFinite(guess) ? guess : 0,
      path: [],
      meanAbsCents: NaN,
      withinFiftyCents: 0,
      segments: [],
      styleDiff,
    };
  }

  // Choose the transposition on a coarser grid (several DTW passes), then align once at full resolution.
  const search = contoursWithin(user, ref, MAX_CELLS_SEARCH);
  const shift =
    search.step > step && search.user.midi.length >= MIN_CONTOUR_POINTS && search.ref.midi.length >= MIN_CONTOUR_POINTS
      ? estimateTranspose(search.user, search.ref)
      : estimateTranspose(userC, refC);

  const pairs = alignedPairs(userC, refC, shift);
  const cents = pairs.map((p) => p.cents);
  const meanAbsCents = mean(cents.map(Math.abs));
  const withinFiftyCents = cents.filter((c) => Math.abs(c) <= 50).length / cents.length;

  const segments: ReferenceSegmentComparison[] = [];
  for (const w of segmentWindows(ref, pairs)) {
    const seg = compareSegment(w, pairs, step, user);
    if (seg) segments.push(seg);
  }

  return {
    transposeSemitones: shift,
    path: decimate(pairs, MAX_PATH_POINTS).map((p) => ({ userT: round3(p.userT), refT: round3(p.refT), centsDiff: round1(p.cents) })),
    meanAbsCents: round1(meanAbsCents),
    withinFiftyCents,
    segments,
    styleDiff,
  };
}
