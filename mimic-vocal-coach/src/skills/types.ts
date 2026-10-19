// Skills section: shared data contracts (see src/skills/SPEC.md). Every skills module and screen codes against these
// types so they can be built in parallel; change them only with care and update SPEC.md with them.
//
// Conventions (same as src/types.ts)
// - Pitch is fractional MIDI (A4 = 69 at settings.a4Hz). Cents are hundredths of a semitone; signed cents are
//   "sung minus asked": positive = sharp / too high / too wide.
// - Times are seconds from the start of the take.
// - Anything that may be persisted uses `null` for "not measured", never NaN.

import type { InterruptionReason } from '../audio/recorder';
import type { AppSettings, VoiceType } from '../types';

// ---------------------------------------------------------------------------------------------
// Shared constants (cross-module numbers live here so screens, scorers and storage agree)

export type Strictness = 'gentle' | 'standard' | 'strict';
/** How far from the target a note may be and still count as "in tune", in cents (25 = a quarter of a semitone). */
export const STRICTNESS_CENTS: Readonly<Record<Strictness, number>> = Object.freeze({ gentle: 50, standard: 25, strict: 15 });
export const STRICTNESS_LABELS: Readonly<Record<Strictness, string>> = Object.freeze({ gentle: 'Gentle', standard: 'Standard', strict: 'Strict' });
export const DEFAULT_STRICTNESS: Strictness = 'standard';
/** Secondary yardstick every summary reports alongside the strictness band. */
export const WIDE_BAND_CENTS = 50;

export const SKILLS_STORE_KEY = 'mimic:v1:skills';
export const SKILLS_STORE_VERSION = 1;
export const MAX_SKILLS_SESSIONS = 500;

// ---------------------------------------------------------------------------------------------
// Music theory (src/skills/theory)

/** Rising/falling melodic interval, or both notes together (listening only). */
export type IntervalDirection = 'up' | 'down' | 'harmonic';
/** Directions a singer can sing. */
export type SungDirection = 'up' | 'down';

export interface IntervalInfo {
  /** 0..12 simple, 13..17 compound (kept open for later). */
  semitones: number;
  /** "P1", "m2", "M2", "m3", "M3", "P4", "TT", "P5", "m6", "M6", "m7", "M7", "P8", "m9" ... */
  short: string;
  /** "unison", "minor 2nd", ..., "tritone", ..., "octave". */
  name: string;
  /** Other common names, e.g. the tritone's "augmented 4th / diminished 5th". */
  altName: string | null;
}

export type ScaleMode = 'major' | 'natural-minor' | 'harmonic-minor';
export type Degree = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** What the singer may type or see: 8 is the tonic an octave up. */
export type WrittenDegree = Degree | 8;
/** How scale degrees are shown: numbers (default), movable-do solfege (do-based minor), or note names in the key. */
export type LabelMode = 'numbers' | 'solfege' | 'names';

/** A key fixed in absolute pitch: `tonicMidi` is degree 1 of the line's home octave. */
export interface MusicalKey {
  tonicMidi: number;
  mode: ScaleMode;
}

/** One note of a scale-degree line, placed relative to the tonic. */
export interface SeqNote {
  degree: Degree;
  /** As typed or generated (8 stays 8 for display). */
  written: WrittenDegree;
  /** Octave of `degree` relative to the tonic's home octave (written 8 with no marks = degree 1, octave 1). */
  octave: number;
  /** Semitones above (negative: below) the tonic of the home octave = octave * 12 + scale step of `degree`. */
  semitones: number;
  /** True when the octave came from explicit marks (+ ' or -), false when the nearest-octave rule chose it. */
  explicit: boolean;
}

export type SequenceParse =
  | { ok: true; notes: SeqNote[]; /** Canonical text with explicit marks, e.g. "2 7- 6- 5-". */ normalized: string }
  | { ok: false; error: string; /** 0-based character position of the problem, when there is one. */ at: number | null };

/** A line ready to play and score: a key plus notes with absolute pitches. */
export interface SequenceTarget {
  key: MusicalKey;
  notes: SeqNote[];
  /** Absolute MIDI of each note (key.tonicMidi + note.semitones). */
  midis: number[];
  /** Canonical text (SequenceParse.normalized). */
  text: string;
}

export interface SequencePreset {
  id: string;
  label: string;
  /** Sequence text in the parser's syntax. */
  text: string;
}

/** Comfortable singing range, MIDI inclusive. */
export interface VoiceRange {
  lowMidi: number;
  highMidi: number;
}
/** Thirds of the comfortable range (pitch test and per-register stats). */
export type RegisterThird = 'low' | 'mid' | 'high';

/** One sound the prompt player makes: a note or a chord (several MIDI notes) at a time offset. Pure data. */
export interface ToneEvent {
  midis: number[];
  startSec: number;
  durSec: number;
  /** 0..1 relative loudness (default 1). Chords use less per note. */
  gain?: number;
  /** What the event is, for UI highlighting. */
  role: 'cadence' | 'tonic' | 'reference' | 'target' | 'line' | 'answer';
  /** Index into the sequence/line the event belongs to, when it has one. */
  index?: number;
}

export interface PacedBreathRound {
  inhale: number;
  suspend: number;
  exhale: number;
}

// ---------------------------------------------------------------------------------------------
// Ear training

export type EarQuestion =
  | {
      kind: 'interval';
      id: string;
      /** The first note played (for 'down' the higher one; for 'harmonic' the lower one). */
      firstMidi: number;
      semitones: number;
      direction: IntervalDirection;
      /** Semitone values offered as answer buttons, ascending. */
      choices: number[];
    }
  | {
      kind: 'degree';
      id: string;
      key: MusicalKey;
      degree: Degree;
      /** The single note played after the cadence. */
      midi: number;
      choices: Degree[];
    };

export interface EarAnswer {
  questionId: string;
  kind: 'interval' | 'degree';
  /** interval: semitones; degree: the scale degree. */
  correctValue: number;
  chosenValue: number;
  correct: boolean;
  direction: IntervalDirection | null;
  mode: ScaleMode | null;
  replays: number;
  responseMs: number;
}

/** Interval level sets for ear training (theory/intervals.ts EAR_LEVELS). */
export type EarSetMode = 'level' | 'custom' | 'adaptive';

// ---------------------------------------------------------------------------------------------
// Live capture (src/skills/audio)

/** One live reading (about every 20-50 ms from the analyser). */
export interface LiveReading {
  t: number;
  hz: number | null;
  /** Fractional MIDI at settings.a4Hz; null when unvoiced. */
  midi: number | null;
  rmsDb: number;
  periodicity: number;
}

export type AutoStopRule =
  /** Single held note: stop once a steady note has been held `holdSec`, or at `capSec`. */
  | { kind: 'held-note'; holdSec: number; steadyCents: number; capSec: number }
  /** A line of notes: stop after `silenceSec` of silence once `expectedNotes` have been heard, or at `capSec`. */
  | { kind: 'notes'; expectedNotes: number; silenceSec: number; capSec: number }
  /** Hiss / long tone: stop after `silenceSec` of silence once sound has started, or at `capSec`. */
  | { kind: 'sustain'; silenceSec: number; capSec: number }
  /** Only the button, the key or the cap. */
  | { kind: 'manual'; capSec: number };

export type StopReason = 'button' | 'key' | 'auto-held' | 'auto-silence' | 'cap' | 'interrupted';

export interface CaptureResult {
  samples: Float32Array;
  sampleRate: number;
  stoppedBy: StopReason;
  interrupted: InterruptionReason | null;
}

// ---------------------------------------------------------------------------------------------
// Scoring results (src/skills/score)

/** 'too-quiet': not enough sound to score (never a fake number). 'no-pitch': sound, but no steady pitched note. */
export type TakeStatus = 'ok' | 'too-quiet' | 'no-pitch';

export interface Finding {
  /** good = praise, info = neutral fact, work = what to practise next. Never "you failed". */
  tone: 'good' | 'info' | 'work';
  text: string;
}

export interface ScoreOptions {
  a4Hz: number;
  toleranceCents: number;
}

/** One sung note found in a take. */
export interface SungNote {
  startSec: number;
  endSec: number;
  /** Held pitch: median over the steady part (whole vibrato cycles), fractional MIDI. */
  midi: number;
  /** Mean of the first steady 200 ms, fractional MIDI; null when the note was too short. */
  landingMidi: number | null;
  /** SD of the 200 ms-smoothed pitch over the steady part, cents (vibrato itself is not counted). */
  stabilityCents: number;
  steadySec: number;
  meanRmsDb: number;
  /**
   * How far `midi` can be trusted. 'low' = too little steady pitch to measure reliably (a very short note, or a wide
   * vibrato caught over less than one cycle): shown, but kept out of averages, drift and the progress stats. Absent
   * means 'high'.
   */
  confidence?: 'high' | 'low';
}

export interface HeldNoteScore {
  status: TakeStatus;
  targetMidi: number;
  sung: SungNote | null;
  /** Whole octaves between what was sung and the target (pitch class is judged; non-zero = "right note, different octave"). */
  octaveOffset: number;
  landingCents: number | null;
  heldCents: number | null;
  stabilityCents: number | null;
  /** From voice onset until the 200 ms average entered the tolerance band and stayed 300 ms. Null if it never did. */
  timeToLandSec: number | null;
  within: boolean;
  register: RegisterThird;
  /**
   * Pitch over the last 0.5 s of the steady part against the steady part before it, cents (- = sagged flat). Null
   * when the note was too short to tell; absent on older results.
   */
  endDriftCents?: number | null;
  findings: Finding[];
}

export interface RegisterStats {
  n: number;
  meanAbsCents: number | null;
  biasCents: number | null;
  shareWithin: number | null;
}

export interface PitchTestSummary {
  scored: number;
  unscored: number;
  meanAbsCents: number | null;
  /** 0..1 share of scored notes within the strictness tolerance. */
  shareWithin: number | null;
  /** 0..1 share within WIDE_BAND_CENTS. */
  shareWithin50: number | null;
  /** Mean signed held error: + tends sharp, - tends flat. */
  biasCents: number | null;
  meanStabilityCents: number | null;
  meanTimeToLandSec: number | null;
  octaveSlips: number;
  /** Notes sung as a different note (WRONG_NOTE_CENTS or more away, not just another octave); kept out of the averages. */
  wrongNotes?: number;
  byRegister: Record<RegisterThird, RegisterStats>;
  findings: Finding[];
}

export interface IntervalTarget {
  referenceMidi: number;
  semitones: number;
  direction: SungDirection;
}

export interface SungIntervalScore {
  status: TakeStatus;
  target: IntervalTarget;
  first: SungNote | null;
  second: SungNote | null;
  /** First sung note against the reference (pitch class judged). */
  referenceCents: number | null;
  /** Sung interval size minus asked size, in the asked direction: + too wide, - too narrow. The core number. */
  intervalCents: number | null;
  /** Second sung note against the absolute target. */
  targetCents: number | null;
  /** Signed sung interval in semitones (negative = went down). */
  sungSemitones: number | null;
  wrongDirection: boolean;
  octaveOffset: number;
  /** |intervalCents| within tolerance. */
  within: boolean;
  findings: Finding[];
}

export interface SequenceNoteScore {
  index: number;
  degree: Degree;
  written: WrittenDegree;
  expectedMidi: number;
  /** null = missing (not sung). */
  sung: SungNote | null;
  /** Against the key, after removing the whole-take octave offset. */
  cents: number | null;
  /** Error of the step from the previous matched note: (sung step) - (asked step), cents. */
  intervalCents: number | null;
  within: boolean;
  /** This note alone was an octave away from the rest (folded and flagged). */
  octaveSlip: boolean;
}

export interface SequenceScore {
  status: TakeStatus;
  target: SequenceTarget;
  notes: SequenceNoteScore[];
  /** Sung notes the alignment did not match to any expected note. */
  extras: SungNote[];
  missing: number;
  /** Whole-take octave offset (-1 = sung an octave lower, which is fine). */
  octaveOffset: number;
  /** 0..1 share of expected notes within tolerance (missing notes count as not within). */
  noteAccuracy: number | null;
  meanAbsCents: number | null;
  biasCents: number | null;
  meanAbsIntervalCents: number | null;
  /** Trend of the signed error from the first to the last note, cents (- = slid flat). */
  driftCents: number | null;
  /**
   * Right shape in the wrong key: every matched note sat about this far from the key (cents, + = above). Absent or
   * null when the line was in the key. Such takes are kept out of the per-degree tuning profile.
   */
  keyShiftCents?: number | null;
  findings: Finding[];
}

export interface HissScore {
  status: 'ok' | 'too-quiet' | 'voiced';
  durationSec: number;
  /** SD of the 100 ms-smoothed hiss level, dB (lower = steadier). */
  steadinessDb: number | null;
  noiseFloorDb: number;
  startSec: number | null;
  endSec: number | null;
  /** Hiss level every 100 ms (dBFS) for a small chart. */
  levelTrace: number[];
  findings: Finding[];
}

export interface LongToneScore {
  status: TakeStatus;
  durationSec: number;
  midi: number | null;
  /** SD of the 200 ms-smoothed pitch, cents (vibrato not counted). */
  pitchSdCents: number | null;
  /**
   * Pitch over the last second against the steady part before it, cents (- = sagged flat), vibrato not counted. A
   * sag at the end is reported even when the overall SD reads steady. Null when too short; absent on older results.
   */
  endDriftCents?: number | null;
  loudnessSdDb: number | null;
  levelTrace: number[];
  pitchTrace: number[];
  findings: Finding[];
}

// ---------------------------------------------------------------------------------------------
// Progress store (src/skills/progress), persisted under SKILLS_STORE_KEY

/** `${semitones}${'u' | 'd' | 'h'}`, e.g. "7u" = perfect 5th up, "4h" = major 3rd harmonic. */
export type IntervalKey = `${number}${'u' | 'd' | 'h'}`;
/** `${mode}:${degree}`, e.g. "major:7". */
export type DegreeKey = `${ScaleMode}:${Degree}`;

/** Exponential moving recognition rate. */
export interface RateStat {
  n: number;
  /** 0..1 moving share correct. */
  ema: number;
  lastAt: string;
}
/** Exponential moving tuning error. */
export interface CentsStat {
  n: number;
  emaSigned: number;
  emaAbs: number;
  lastAt: string;
}
export interface BestRecord {
  value: number;
  at: string;
}

export interface SkillsStats {
  /** Interval recognition by interval and direction. */
  hear: Partial<Record<IntervalKey, RateStat>>;
  /** Interval singing (intervalCents) by interval and direction ('u' | 'd'). */
  sing: Partial<Record<IntervalKey, CentsStat>>;
  /** "Hear the degree" recognition by key mode and degree. */
  hearDegree: Partial<Record<DegreeKey, RateStat>>;
  /** Sung tuning per degree (sequence note cents against the key). */
  degrees: Partial<Record<DegreeKey, CentsStat>>;
  /** Held-note tuning per register third (pitch test and match). */
  registers: Partial<Record<RegisterThird, CentsStat>>;
}

export interface SkillsBests {
  hissSec: BestRecord | null;
  longToneSec: BestRecord | null;
  pacedExhaleCounts: BestRecord | null;
}

export interface SkillsPrefs {
  strictness: Strictness;
  labelMode: LabelMode;
  scaleMode: ScaleMode;
  earSetMode: EarSetMode;
  /** 1..5 (theory EAR_LEVELS). */
  earLevel: number;
  /** Semitones for the custom set (0..12). */
  earCustom: number[];
  earDirections: IntervalDirection[];
  /** Answer to "Are you wearing headphones?" (gates drone mode); null = not asked yet. */
  headphones: boolean | null;
  /** Overrides the voice-type range when set. */
  rangeOverride: VoiceRange | null;
}

export type SkillsExerciseKind = 'pitch-test' | 'match' | 'ear' | 'sing-intervals' | 'sequence' | 'breath' | 'workout';

interface SessionBase {
  /** Unique id (crypto.randomUUID or time+random). */
  id: string;
  /** ISO time the session finished. */
  at: string;
  durationSec: number;
  strictness: Strictness;
  voiceType: VoiceType;
  a4Hz: number;
  /** Set on sessions that were steps of a daily workout. */
  workoutId?: string;
}

export interface PitchTestNoteLite {
  targetMidi: number;
  register: RegisterThird;
  status: TakeStatus;
  heldCents: number | null;
  landingCents: number | null;
  stabilityCents: number | null;
  timeToLandSec: number | null;
  octaveOffset: number;
}

export interface PitchTestSession extends SessionBase {
  kind: 'pitch-test';
  notes: PitchTestNoteLite[];
  summary: Omit<PitchTestSummary, 'findings'>;
}

export interface MatchSession extends SessionBase {
  kind: 'match';
  drone: boolean;
  attempts: { targetMidi: number; register: RegisterThird; locked: boolean; lockSec: number | null; heldCents: number | null }[];
}

export interface EarSession extends SessionBase {
  kind: 'ear';
  mode: 'interval' | 'degree';
  answers: EarAnswer[];
  correct: number;
  total: number;
}

export interface SingIntervalsSession extends SessionBase {
  kind: 'sing-intervals';
  items: {
    mode: 'read' | 'listen';
    semitones: number;
    direction: SungDirection;
    referenceMidi: number;
    status: TakeStatus;
    referenceCents: number | null;
    intervalCents: number | null;
    targetCents: number | null;
  }[];
  meanAbsIntervalCents: number | null;
}

export interface SequenceSession extends SessionBase {
  kind: 'sequence';
  items: {
    mode: 'read' | 'listen';
    text: string;
    scaleMode: ScaleMode;
    tonicMidi: number;
    status: TakeStatus;
    noteAccuracy: number | null;
    meanAbsCents: number | null;
    meanAbsIntervalCents: number | null;
    driftCents: number | null;
    octaveOffset: number;
    /** Matched notes only (missing ones are left out). */
    perNote: { degree: Degree; cents: number }[];
    missing: number;
    extras: number;
  }[];
}

export interface BreathSession extends SessionBase {
  kind: 'breath';
  paced: { rounds: number; maxExhaleCounts: number } | null;
  hiss: { status: HissScore['status']; durationSec: number; steadinessDb: number | null } | null;
  longTone: { status: TakeStatus; durationSec: number; midi: number | null; pitchSdCents: number | null; loudnessSdDb: number | null } | null;
}

export interface WorkoutSession extends SessionBase {
  kind: 'workout';
  /** Ids of the step sessions recorded with this workoutId. */
  partIds: string[];
  completedSteps: number;
  totalSteps: number;
}

export type SkillsSession = PitchTestSession | MatchSession | EarSession | SingIntervalsSession | SequenceSession | BreathSession | WorkoutSession;

export interface SkillsStore {
  version: typeof SKILLS_STORE_VERSION;
  /** Oldest first, at most MAX_SKILLS_SESSIONS. */
  sessions: SkillsSession[];
  stats: SkillsStats;
  bests: SkillsBests;
  prefs: SkillsPrefs;
}

// ---------------------------------------------------------------------------------------------
// Routing and screens (src/state/routing.ts additions, src/ui/skills)

export const SKILLS_VIEWS = ['hub', 'pitch-test', 'match', 'ear', 'sing-intervals', 'sequence', 'breath', 'workout', 'progress'] as const;
export type SkillsView = (typeof SKILLS_VIEWS)[number];

export interface SkillsPath {
  view: SkillsView;
  /** From "?seed=N" (tests and reproducible targets); null = random. */
  seed: number | null;
}

/** Props every exercise screen takes. */
export interface SkillScreenProps<S extends SkillsSession = SkillsSession> {
  settings: AppSettings;
  prefs: SkillsPrefs;
  stats: SkillsStats;
  /** Fixed seed for deterministic targets; undefined = random. */
  seed?: number;
  /** Inside the daily workout: no back link or page header, the plan below decides the length. */
  embedded?: boolean;
  /** Called once with the finished session (also when the singer stops early with at least one scored item). */
  onDone(session: S): void;
  /** Back to the hub (or skip this workout step). */
  onExit(): void;
  /** Persists a preference change (strictness, label mode, headphones answer ...). */
  onPrefs?(patch: Partial<SkillsPrefs>): void;
}

/** What a workout step asks of a screen. */
export interface PitchTestPlan {
  count: number;
}
export interface MatchPlan {
  count: number;
}
export interface EarPlan {
  mode: 'interval' | 'degree';
  questions: number;
  /** Fixed interval set (semitones); undefined = from prefs. */
  set?: number[];
}
export interface SingIntervalsPlan {
  count: number;
  mode: 'read' | 'listen';
}
export interface SequencePlan {
  /** Sequence texts in order; undefined = the singer picks. */
  texts?: string[];
  mode: 'read' | 'listen';
}
export interface BreathPlan {
  parts: ('paced' | 'hiss' | 'long-tone')[];
  pacedRounds?: number;
}

/** One step of the daily workout (src/skills/progress/workout.ts buildWorkout). */
export type WorkoutStep =
  | { kind: 'breath'; label: string; estSec: number; plan: BreathPlan }
  | { kind: 'match'; label: string; estSec: number; plan: MatchPlan }
  | { kind: 'ear'; label: string; estSec: number; plan: EarPlan }
  | { kind: 'sing-intervals'; label: string; estSec: number; plan: SingIntervalsPlan }
  | { kind: 'sequence'; label: string; estSec: number; plan: SequencePlan };

/** Series the Skills progress charts draw (src/skills/progress/history.ts). */
export type SkillsMetric =
  | 'pitch-mean-abs-cents'
  | 'ear-accuracy'
  | 'interval-abs-cents'
  | 'sequence-accuracy'
  | 'hiss-sec'
  | 'long-tone-sec';
