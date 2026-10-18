// Field-by-field validation of everything the Skills store keeps (src/skills/SPEC.md section 5). Never throws: a bad
// session is dropped, a bad optional number becomes null, a bad preference falls back to its default on its own.

import { isRecord } from '../../storage/local';
import { parseIntervalKey } from '../theory/intervals';
import { isDegree, isScaleMode } from '../theory/scales';
import { MIN_RANGE_SEMITONES } from '../theory/range';
import {
  DEFAULT_STRICTNESS,
  MAX_SKILLS_SESSIONS,
  type BestRecord,
  type BreathSession,
  type CentsStat,
  type Degree,
  type DegreeKey,
  type EarAnswer,
  type EarSession,
  type EarSetMode,
  type IntervalDirection,
  type IntervalKey,
  type LabelMode,
  type MatchSession,
  type PitchTestNoteLite,
  type PitchTestSession,
  type RateStat,
  type RegisterStats,
  type RegisterThird,
  type ScaleMode,
  type SequenceSession,
  type SingIntervalsSession,
  type SkillsBests,
  type SkillsPrefs,
  type SkillsSession,
  type SkillsStats,
  type Strictness,
  type SungDirection,
  type TakeStatus,
  type VoiceRange,
  type WorkoutSession,
} from '../types';
import type { VoiceType } from '../../types';

// ---------------------------------------------------------------------------------------------
// Limits (a stored session bigger than these is not one this app wrote)

export const MAX_ITEMS_PER_SESSION = 200;
export const MAX_ANSWERS_PER_SESSION = 500;
export const MAX_NOTES_PER_LINE = 32;
export const MAX_PARTS_PER_WORKOUT = 20;
/** Cents beyond this are garbage, not a measurement (scores are judged on pitch class: |c| <= 600). */
const MAX_ABS_CENTS = 2400;
const MAX_DURATION_SEC = 6 * 3600;

// ---------------------------------------------------------------------------------------------
// Small validators

export function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
/** A finite number in [lo, hi], else null. */
export function numIn(x: unknown, lo: number, hi: number): number | null {
  return finite(x) && x >= lo && x <= hi ? x : null;
}
export function centsOrNull(x: unknown): number | null {
  return numIn(x, -MAX_ABS_CENTS, MAX_ABS_CENTS);
}
function absCentsOrNull(x: unknown): number | null {
  return numIn(x, 0, MAX_ABS_CENTS);
}
function shareOrNull(x: unknown): number | null {
  return numIn(x, 0, 1);
}
function secOrNull(x: unknown): number | null {
  return numIn(x, 0, MAX_DURATION_SEC);
}
function midiOrNull(x: unknown): number | null {
  return numIn(x, 0, 127);
}
function intIn(x: unknown, lo: number, hi: number): number | null {
  return finite(x) && Number.isInteger(x) && x >= lo && x <= hi ? x : null;
}
/** A parseable ISO-like timestamp string, else null. */
export function isoOrNull(x: unknown): string | null {
  return typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : null;
}
function oneOf<T extends string>(x: unknown, allowed: readonly T[]): T | null {
  return typeof x === 'string' && (allowed as readonly string[]).includes(x) ? (x as T) : null;
}
function arr(x: unknown, max: number): unknown[] {
  return Array.isArray(x) ? x.slice(0, max) : [];
}
/** Parses each element, keeping the ones that are not null. */
function list<T>(x: unknown, max: number, parse: (v: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const v of arr(x, max)) {
    const p = parse(v);
    if (p !== null) out.push(p);
  }
  return out;
}

const STRICTNESS: readonly Strictness[] = ['gentle', 'standard', 'strict'];
const VOICE_TYPES: readonly VoiceType[] = ['bass', 'baritone', 'tenor', 'alto', 'mezzo', 'soprano'];
const LABEL_MODES: readonly LabelMode[] = ['numbers', 'solfege', 'names'];
const SCALE_MODES: readonly ScaleMode[] = ['major', 'natural-minor', 'harmonic-minor'];
const EAR_SET_MODES: readonly EarSetMode[] = ['level', 'custom', 'adaptive'];
const DIRECTIONS: readonly IntervalDirection[] = ['up', 'down', 'harmonic'];
const SUNG_DIRECTIONS: readonly SungDirection[] = ['up', 'down'];
const REGISTERS: readonly RegisterThird[] = ['low', 'mid', 'high'];
const TAKE_STATUSES: readonly TakeStatus[] = ['ok', 'too-quiet', 'no-pitch'];
const ITEM_MODES = ['read', 'listen'] as const;

// ---------------------------------------------------------------------------------------------
// Preferences

export const DEFAULT_SKILLS_PREFS: SkillsPrefs = Object.freeze({
  strictness: DEFAULT_STRICTNESS,
  labelMode: 'numbers',
  scaleMode: 'major',
  earSetMode: 'level',
  earLevel: 1,
  earCustom: Object.freeze([]) as unknown as number[],
  earDirections: Object.freeze(['up', 'down']) as unknown as IntervalDirection[],
  headphones: null,
  rangeOverride: null,
}) as SkillsPrefs;

export function parseRangeOverride(x: unknown): VoiceRange | null {
  if (!isRecord(x)) return null;
  const low = intIn(x.lowMidi, 28, 96);
  const high = intIn(x.highMidi, 28, 96);
  if (low === null || high === null || high - low < MIN_RANGE_SEMITONES) return null;
  return { lowMidi: low, highMidi: high };
}

/** One validator per preference: the clean value, or undefined when `x` is not acceptable for that field. */
export const PREF_FIELDS: { [K in keyof SkillsPrefs]: (x: unknown) => SkillsPrefs[K] | undefined } = {
  strictness: (x) => oneOf(x, STRICTNESS) ?? undefined,
  labelMode: (x) => oneOf(x, LABEL_MODES) ?? undefined,
  scaleMode: (x) => oneOf(x, SCALE_MODES) ?? undefined,
  earSetMode: (x) => oneOf(x, EAR_SET_MODES) ?? undefined,
  earLevel: (x) => (finite(x) ? Math.max(1, Math.min(5, Math.round(x))) : undefined),
  earCustom: (x) =>
    Array.isArray(x) ? [...new Set(list(x, 32, (v) => (finite(v) && v >= 0 && v <= 12 ? Math.round(v) : null)))].sort((a, b) => a - b) : undefined,
  earDirections: (x) => {
    const dirs = [...new Set(list(x, 3, (v) => oneOf(v, DIRECTIONS)))];
    return dirs.length > 0 ? dirs : undefined;
  },
  headphones: (x) => (typeof x === 'boolean' || x === null ? x : undefined),
  rangeOverride: (x) => (x === null ? null : (parseRangeOverride(x) ?? undefined)),
};

/** Every field checked on its own; a bad one falls back to its default without resetting the rest. */
export function parseSkillsPrefs(x: unknown): SkillsPrefs {
  const src = isRecord(x) ? x : {};
  const d = DEFAULT_SKILLS_PREFS;
  return {
    strictness: PREF_FIELDS.strictness(src.strictness) ?? d.strictness,
    labelMode: PREF_FIELDS.labelMode(src.labelMode) ?? d.labelMode,
    scaleMode: PREF_FIELDS.scaleMode(src.scaleMode) ?? d.scaleMode,
    earSetMode: PREF_FIELDS.earSetMode(src.earSetMode) ?? d.earSetMode,
    earLevel: PREF_FIELDS.earLevel(src.earLevel) ?? d.earLevel,
    earCustom: PREF_FIELDS.earCustom(src.earCustom) ?? [],
    earDirections: PREF_FIELDS.earDirections(src.earDirections) ?? d.earDirections.slice(),
    headphones: PREF_FIELDS.headphones(src.headphones) ?? null,
    rangeOverride: PREF_FIELDS.rangeOverride(src.rangeOverride) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions

interface BaseFields {
  id: string;
  at: string;
  durationSec: number;
  strictness: Strictness;
  voiceType: VoiceType;
  a4Hz: number;
  workoutId?: string;
}

function parseId(x: unknown): string | null {
  return typeof x === 'string' && x.length > 0 && x.length <= 100 ? x : null;
}

/** The fields every session has; null when the id or time is unusable (the session is dropped). */
function parseBase(x: Record<string, unknown>): BaseFields | null {
  const id = parseId(x.id);
  const at = isoOrNull(x.at);
  if (id === null || at === null) return null;
  const base: BaseFields = {
    id,
    at,
    durationSec: secOrNull(x.durationSec) ?? 0,
    strictness: oneOf(x.strictness, STRICTNESS) ?? DEFAULT_STRICTNESS,
    voiceType: oneOf(x.voiceType, VOICE_TYPES) ?? 'baritone',
    a4Hz: numIn(x.a4Hz, 400, 480) ?? 440,
  };
  const wid = parseId(x.workoutId);
  if (wid !== null) base.workoutId = wid;
  return base;
}

function parsePitchNote(x: unknown): PitchTestNoteLite | null {
  if (!isRecord(x)) return null;
  const targetMidi = midiOrNull(x.targetMidi);
  const register = oneOf(x.register, REGISTERS);
  const status = oneOf(x.status, TAKE_STATUSES);
  if (targetMidi === null || register === null || status === null) return null;
  return {
    targetMidi,
    register,
    status,
    heldCents: centsOrNull(x.heldCents),
    landingCents: centsOrNull(x.landingCents),
    stabilityCents: absCentsOrNull(x.stabilityCents),
    timeToLandSec: secOrNull(x.timeToLandSec),
    octaveOffset: intIn(x.octaveOffset, -4, 4) ?? 0,
  };
}

function parseRegisterStats(x: unknown): RegisterStats {
  const src = isRecord(x) ? x : {};
  return {
    n: intIn(src.n, 0, 10_000) ?? 0,
    meanAbsCents: absCentsOrNull(src.meanAbsCents),
    biasCents: centsOrNull(src.biasCents),
    shareWithin: shareOrNull(src.shareWithin),
  };
}

function parsePitchSummary(x: unknown): PitchTestSession['summary'] {
  const s = isRecord(x) ? x : {};
  const by = isRecord(s.byRegister) ? s.byRegister : {};
  return {
    scored: intIn(s.scored, 0, 10_000) ?? 0,
    unscored: intIn(s.unscored, 0, 10_000) ?? 0,
    meanAbsCents: absCentsOrNull(s.meanAbsCents),
    shareWithin: shareOrNull(s.shareWithin),
    shareWithin50: shareOrNull(s.shareWithin50),
    biasCents: centsOrNull(s.biasCents),
    meanStabilityCents: absCentsOrNull(s.meanStabilityCents),
    meanTimeToLandSec: secOrNull(s.meanTimeToLandSec),
    octaveSlips: intIn(s.octaveSlips, 0, 10_000) ?? 0,
    byRegister: { low: parseRegisterStats(by.low), mid: parseRegisterStats(by.mid), high: parseRegisterStats(by.high) },
  };
}

function parseMatchAttempt(x: unknown): MatchSession['attempts'][number] | null {
  if (!isRecord(x)) return null;
  const targetMidi = midiOrNull(x.targetMidi);
  const register = oneOf(x.register, REGISTERS);
  if (targetMidi === null || register === null || typeof x.locked !== 'boolean') return null;
  return { targetMidi, register, locked: x.locked, lockSec: secOrNull(x.lockSec), heldCents: centsOrNull(x.heldCents) };
}

function parseEarAnswer(x: unknown): EarAnswer | null {
  if (!isRecord(x)) return null;
  const kind = oneOf(x.kind, ['interval', 'degree'] as const);
  if (kind === null) return null;
  const range: [number, number] = kind === 'interval' ? [0, 17] : [1, 7];
  const correctValue = intIn(x.correctValue, range[0], range[1]);
  const chosenValue = intIn(x.chosenValue, range[0], range[1]);
  if (correctValue === null || chosenValue === null) return null;
  return {
    questionId: typeof x.questionId === 'string' ? x.questionId.slice(0, 100) : '',
    kind,
    correctValue,
    chosenValue,
    correct: typeof x.correct === 'boolean' ? x.correct : correctValue === chosenValue,
    direction: oneOf(x.direction, DIRECTIONS),
    mode: oneOf(x.mode, SCALE_MODES),
    replays: intIn(x.replays, 0, 10_000) ?? 0,
    responseMs: numIn(x.responseMs, 0, 3_600_000) ?? 0,
  };
}

function parseSingItem(x: unknown): SingIntervalsSession['items'][number] | null {
  if (!isRecord(x)) return null;
  const mode = oneOf(x.mode, ITEM_MODES);
  const semitones = intIn(x.semitones, 0, 17);
  const direction = oneOf(x.direction, SUNG_DIRECTIONS);
  const referenceMidi = midiOrNull(x.referenceMidi);
  const status = oneOf(x.status, TAKE_STATUSES);
  if (mode === null || semitones === null || direction === null || referenceMidi === null || status === null) return null;
  return {
    mode,
    semitones,
    direction,
    referenceMidi,
    status,
    referenceCents: centsOrNull(x.referenceCents),
    intervalCents: centsOrNull(x.intervalCents),
    targetCents: centsOrNull(x.targetCents),
  };
}

function parsePerNote(x: unknown): { degree: Degree; cents: number } | null {
  if (!isRecord(x) || !isDegree(x.degree)) return null;
  const cents = centsOrNull(x.cents);
  return cents === null ? null : { degree: x.degree, cents };
}

function parseSequenceItem(x: unknown): SequenceSession['items'][number] | null {
  if (!isRecord(x)) return null;
  const mode = oneOf(x.mode, ITEM_MODES);
  const scaleMode = isScaleMode(x.scaleMode) ? x.scaleMode : null;
  const tonicMidi = midiOrNull(x.tonicMidi);
  const status = oneOf(x.status, TAKE_STATUSES);
  if (mode === null || scaleMode === null || tonicMidi === null || status === null || typeof x.text !== 'string') return null;
  return {
    mode,
    text: x.text.slice(0, 200),
    scaleMode,
    tonicMidi,
    status,
    noteAccuracy: shareOrNull(x.noteAccuracy),
    meanAbsCents: absCentsOrNull(x.meanAbsCents),
    meanAbsIntervalCents: absCentsOrNull(x.meanAbsIntervalCents),
    driftCents: centsOrNull(x.driftCents),
    octaveOffset: intIn(x.octaveOffset, -4, 4) ?? 0,
    perNote: list(x.perNote, MAX_NOTES_PER_LINE, parsePerNote),
    missing: intIn(x.missing, 0, 1000) ?? 0,
    extras: intIn(x.extras, 0, 1000) ?? 0,
  };
}

function parseBreathParts(x: Record<string, unknown>): Pick<BreathSession, 'paced' | 'hiss' | 'longTone'> {
  let paced: BreathSession['paced'] = null;
  if (isRecord(x.paced)) {
    const rounds = intIn(x.paced.rounds, 0, 100);
    const maxExhaleCounts = numIn(x.paced.maxExhaleCounts, 0, 120);
    if (rounds !== null && maxExhaleCounts !== null) paced = { rounds, maxExhaleCounts };
  }
  let hiss: BreathSession['hiss'] = null;
  if (isRecord(x.hiss)) {
    const status = oneOf(x.hiss.status, ['ok', 'too-quiet', 'voiced'] as const);
    const durationSec = secOrNull(x.hiss.durationSec);
    if (status !== null && durationSec !== null) hiss = { status, durationSec, steadinessDb: numIn(x.hiss.steadinessDb, 0, 120) };
  }
  let longTone: BreathSession['longTone'] = null;
  if (isRecord(x.longTone)) {
    const status = oneOf(x.longTone.status, TAKE_STATUSES);
    const durationSec = secOrNull(x.longTone.durationSec);
    if (status !== null && durationSec !== null) {
      longTone = {
        status,
        durationSec,
        midi: midiOrNull(x.longTone.midi),
        pitchSdCents: absCentsOrNull(x.longTone.pitchSdCents),
        loudnessSdDb: numIn(x.longTone.loudnessSdDb, 0, 120),
      };
    }
  }
  return { paced, hiss, longTone };
}

/**
 * One stored session, cleaned; null when it is unusable (unknown kind, no id or time, or nothing left to keep).
 * Bad items inside a session are dropped one by one.
 */
export function parseSkillsSession(x: unknown): SkillsSession | null {
  if (!isRecord(x)) return null;
  const base = parseBase(x);
  if (!base) return null;
  switch (x.kind) {
    case 'pitch-test': {
      const notes = list(x.notes, MAX_ITEMS_PER_SESSION, parsePitchNote);
      if (notes.length === 0) return null;
      return { ...base, kind: 'pitch-test', notes, summary: parsePitchSummary(x.summary) } satisfies PitchTestSession;
    }
    case 'match': {
      const attempts = list(x.attempts, MAX_ITEMS_PER_SESSION, parseMatchAttempt);
      if (attempts.length === 0) return null;
      return { ...base, kind: 'match', drone: x.drone === true, attempts } satisfies MatchSession;
    }
    case 'ear': {
      const mode = oneOf(x.mode, ['interval', 'degree'] as const);
      if (mode === null) return null;
      const answers = list(x.answers, MAX_ANSWERS_PER_SESSION, parseEarAnswer).filter((a) => a.kind === mode);
      if (answers.length === 0) return null;
      // The counts always agree with the answers kept.
      const correct = answers.filter((a) => a.correct).length;
      return { ...base, kind: 'ear', mode, answers, correct, total: answers.length } satisfies EarSession;
    }
    case 'sing-intervals': {
      const items = list(x.items, MAX_ITEMS_PER_SESSION, parseSingItem);
      if (items.length === 0) return null;
      const scored = items.flatMap((i) => (i.intervalCents === null ? [] : [Math.abs(i.intervalCents)]));
      const stored = absCentsOrNull(x.meanAbsIntervalCents);
      const meanAbsIntervalCents = stored ?? (scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null);
      return { ...base, kind: 'sing-intervals', items, meanAbsIntervalCents } satisfies SingIntervalsSession;
    }
    case 'sequence': {
      const items = list(x.items, MAX_ITEMS_PER_SESSION, parseSequenceItem);
      if (items.length === 0) return null;
      return { ...base, kind: 'sequence', items } satisfies SequenceSession;
    }
    case 'breath': {
      const parts = parseBreathParts(x);
      if (!parts.paced && !parts.hiss && !parts.longTone) return null;
      return { ...base, kind: 'breath', ...parts } satisfies BreathSession;
    }
    case 'workout': {
      const partIds = list(x.partIds, MAX_PARTS_PER_WORKOUT, parseId);
      const totalSteps = intIn(x.totalSteps, 0, MAX_PARTS_PER_WORKOUT) ?? partIds.length;
      const completedSteps = Math.min(totalSteps, intIn(x.completedSteps, 0, MAX_PARTS_PER_WORKOUT) ?? partIds.length);
      return { ...base, kind: 'workout', partIds, completedSteps, totalSteps } satisfies WorkoutSession;
    }
    default:
      return null;
  }
}

const time = (at: string): number => Date.parse(at);

/**
 * Cleans a session list: unusable sessions dropped, one copy per id (the last one wins), oldest first (stable for equal
 * times), and only the newest MAX_SKILLS_SESSIONS kept.
 */
export function parseSessionList(x: unknown, max: number = MAX_SKILLS_SESSIONS): SkillsSession[] {
  // Read at most a few times the cap: anything longer is not a list this app wrote.
  const byId = new Map<string, SkillsSession>();
  for (const v of arr(x, max * 4)) {
    const s = parseSkillsSession(v);
    if (!s) continue;
    byId.delete(s.id);
    byId.set(s.id, s);
  }
  const sorted = sortSessions([...byId.values()]);
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

/** Oldest first; stable for equal times. */
export function sortSessions(sessions: SkillsSession[]): SkillsSession[] {
  return sessions
    .map((s, i) => ({ s, i, t: time(s.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.s);
}

// ---------------------------------------------------------------------------------------------
// Stats and bests

function parseRate(x: unknown): RateStat | null {
  if (!isRecord(x)) return null;
  const n = intIn(x.n, 1, 1_000_000);
  const ema = shareOrNull(x.ema);
  const lastAt = isoOrNull(x.lastAt);
  return n === null || ema === null || lastAt === null ? null : { n, ema, lastAt };
}

function parseCentsStat(x: unknown): CentsStat | null {
  if (!isRecord(x)) return null;
  const n = intIn(x.n, 1, 1_000_000);
  const emaSigned = centsOrNull(x.emaSigned);
  const emaAbs = absCentsOrNull(x.emaAbs);
  const lastAt = isoOrNull(x.lastAt);
  return n === null || emaSigned === null || emaAbs === null || lastAt === null ? null : { n, emaSigned, emaAbs, lastAt };
}

function isIntervalKey(k: string, directions: readonly IntervalDirection[]): k is IntervalKey {
  const p = parseIntervalKey(k);
  return p !== null && directions.includes(p.direction);
}

export function isDegreeKey(k: string): k is DegreeKey {
  const i = k.lastIndexOf(':');
  if (i < 0) return false;
  return isScaleMode(k.slice(0, i)) && isDegree(Number(k.slice(i + 1))) && /^[1-7]$/.test(k.slice(i + 1));
}

function statMap<K extends string, V>(x: unknown, validKey: (k: string) => k is K, parse: (v: unknown) => V | null): Partial<Record<K, V>> {
  const out: Partial<Record<K, V>> = {};
  if (!isRecord(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    if (!validKey(k)) continue;
    const p = parse(v);
    if (p !== null) out[k] = p;
  }
  return out;
}

export function emptySkillsStats(): SkillsStats {
  return { hear: {}, sing: {}, hearDegree: {}, degrees: {}, registers: {} };
}

export function parseSkillsStats(x: unknown): SkillsStats {
  const src = isRecord(x) ? x : {};
  return {
    hear: statMap(src.hear, (k): k is IntervalKey => isIntervalKey(k, DIRECTIONS), parseRate),
    sing: statMap(src.sing, (k): k is IntervalKey => isIntervalKey(k, ['up', 'down']), parseCentsStat),
    hearDegree: statMap(src.hearDegree, isDegreeKey, parseRate),
    degrees: statMap(src.degrees, isDegreeKey, parseCentsStat),
    registers: statMap(src.registers, (k): k is RegisterThird => (REGISTERS as readonly string[]).includes(k), parseCentsStat),
  };
}

function parseBest(x: unknown, max: number): BestRecord | null {
  if (!isRecord(x)) return null;
  const value = numIn(x.value, 0, max);
  const at = isoOrNull(x.at);
  return value === null || value <= 0 || at === null ? null : { value, at };
}

export function emptySkillsBests(): SkillsBests {
  return { hissSec: null, longToneSec: null, pacedExhaleCounts: null };
}

export function parseSkillsBests(x: unknown): SkillsBests {
  const src = isRecord(x) ? x : {};
  return {
    hissSec: parseBest(src.hissSec, MAX_DURATION_SEC),
    longToneSec: parseBest(src.longToneSec, MAX_DURATION_SEC),
    pacedExhaleCounts: parseBest(src.pacedExhaleCounts, 120),
  };
}

