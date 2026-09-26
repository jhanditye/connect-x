// Shared data contracts. Every module codes against these types; change them only with care.
//
// Conventions
// - Times are seconds from the start of the take. Pitch is Hz or fractional MIDI note numbers
//   (A4 = 69 = 440 Hz unless AnalysisOptions.a4Hz says otherwise).
// - Per-frame arrays use NaN for "not measured" (unvoiced frames etc.). Summary objects that may be
//   persisted as JSON use `null` instead, because JSON turns NaN into null anyway.
// - 0..1 indices are documented with anchor meanings so the analysis engine and the singer
//   profiles agree on what a number means.

export type RegisterLabel = 'chest' | 'mix' | 'head';

/** User's voice type. Drives the passaggio (register-transition) zone used for mix coaching. */
export type VoiceType = 'bass' | 'baritone' | 'tenor' | 'alto' | 'mezzo' | 'soprano';

export interface AnalysisOptions {
  voiceType: VoiceType;
  /** Reference tuning, default 440. */
  a4Hz?: number;
}

/** Passaggio zone for a voice type, as MIDI numbers. Frames at or above `lowMidi` count as "upper range". */
export interface PassaggioZone {
  lowMidi: number;
  highMidi: number;
}

/** One analysis frame (hop = VoiceAnalysis.hopSec, nominally 10 ms). */
export interface FrameFeatures {
  t: number;
  /** Fundamental frequency in Hz; NaN when unvoiced. */
  f0: number;
  /** Fractional MIDI note; NaN when unvoiced. */
  midi: number;
  voiced: boolean;
  /** 0..1, 1 = perfectly periodic (1 - YIN aperiodicity). */
  periodicity: number;
  /** Frame RMS in dBFS (full-scale sine = -3 dBFS). */
  rmsDb: number;
  /** Amplitude of harmonic 1 minus harmonic 2, dB. Higher = breathier / lighter / more falsetto-like. NaN if unvoiced. */
  h1h2Db: number;
  /** Alpha ratio: energy 1-5 kHz relative to 50 Hz-1 kHz, dB. Higher = brighter / more "ring". NaN if unvoiced. */
  alphaRatioDb: number;
  /** Spectral centroid, Hz. NaN if unvoiced. */
  centroidHz: number;
  /** Slope of harmonic amplitudes vs log2(frequency) up to 5 kHz, dB/octave (negative; steeper = darker/lighter fold). */
  tiltDbPerOct: number;
  /** Cepstral peak prominence, dB. Higher = clearer, more periodic voice; low = breathy or rough. */
  cppDb: number;
  /** Harmonics-to-noise ratio estimate, dB. */
  hnrDb: number;
  /** Heuristic register estimate for voiced frames, null when unvoiced or too uncertain. */
  register: RegisterLabel | null;
}

export interface NoteSegment {
  start: number;
  end: number;
  /** Mean fractional MIDI over the note's stable part. */
  midi: number;
  /** Nearest equal-tempered note after global tuning correction. */
  nearestMidi: number;
  /** Signed deviation from nearestMidi in cents after tuning correction. */
  centsOff: number;
  vibrato: { rateHz: number; extentCents: number } | null;
  register: RegisterLabel | null;
  meanRmsDb: number;
}

export interface Phrase {
  start: number;
  end: number;
}

export type OnsetType = 'breathy' | 'balanced' | 'glottal';

export interface Onset {
  t: number;
  type: OnsetType;
}

/** A fast melismatic passage (vocal run). */
export interface Run {
  start: number;
  end: number;
  noteCount: number;
  notesPerSec: number;
}

/**
 * Normalised style measurements used to compare a take against a singer profile.
 * `null` means the take did not contain enough material to measure it (e.g. no sustained notes for vibrato).
 */
export interface StyleVector {
  /**
   * 0..1. 0-0.2 very clean and firm, 0.3-0.5 clear balanced tone (typical clean real singing reads ~0.28-0.44),
   * 0.6-0.8 clearly airy (soft R&B), 0.9-1 near-whisper. Shifts with the microphone's bass response
   * (a phone mic's bass roll-off lowers it by ~0.1), so compare takes recorded on the same device.
   */
  breathiness: number | null;
  /** 0..1. 0-0.3 dark/covered/warm, 0.4-0.6 neutral, 0.7-1 bright/forward/twangy. */
  brightness: number | null;
  /** 0..1. 0-0.15 clean, 0.2-0.4 slight grit on louder notes, 0.5+ obvious rasp. */
  rasp: number | null;
  /** 0..1 share of sustained notes (>= 0.45 s) that carry vibrato. */
  vibratoPresence: number | null;
  /** Median vibrato rate in Hz across notes that have vibrato. */
  vibratoRateHz: number | null;
  /** Median vibrato semi-extent (± cents) across notes that have vibrato. */
  vibratoExtentCents: number | null;
  /** 0..1 share of upper-range voiced frames (at/above passaggio low) estimated as chest. */
  chestInUpperRange: number | null;
  /** 0..1 share estimated as mix. */
  mixInUpperRange: number | null;
  /** 0..1 share estimated as head/falsetto. */
  headInUpperRange: number | null;
  /** dB of loudness gained per semitone climbed within the upper range. > ~0.8 suggests pushing chest weight up. */
  loudnessClimbDbPerSemitone: number | null;
  /** Notes per second inside detected runs; 0 when the take has no runs. */
  agility: number | null;
  /** Spread of voiced loudness, 95th minus 5th percentile, dB. */
  dynamicRangeDb: number | null;
  /** 0..1 share of phrase onsets that are breathy (aspirated). */
  softOnsetRatio: number | null;
  /** Mean absolute deviation of sustained notes from the nearest semitone, cents (after tuning correction). Lower is better. */
  pitchAccuracyCents: number | null;
  /** Register flips (sudden switch into head voice with a pitch jump) per minute of singing. */
  flipsPerMinute: number | null;
}

export type StyleKey = keyof StyleVector;

export interface AudioQuality {
  /** Share of samples at or near full scale. */
  clippingRatio: number;
  /** Noise floor estimate, dBFS (10th percentile of frame RMS). */
  noiseFloorDb: number;
  /** Median voiced RMS minus noise floor, dB. NaN when the take has too few pauses to measure the room noise. */
  snrDb: number;
}

/**
 * Machine-readable problems with a take, so the coach and UI can react without parsing warning text.
 * - too-little-singing: under ~3 s of voiced singing; style measures are unreliable or null.
 * - accompaniment: sounds like singing over instruments (a song mix); pitch may follow the bass.
 * - speech-like: mostly short syllables with few held notes; singing measures are unreliable.
 * - noisy / clipping / too-quiet / trimmed: recording-quality problems (see `warnings` for the wording).
 */
export type AnalysisIssue = 'too-little-singing' | 'accompaniment' | 'speech-like' | 'noisy' | 'clipping' | 'too-quiet' | 'trimmed';

export interface VoiceAnalysis {
  version: 1;
  durationSec: number;
  /** Sample rate the analysis ran at (after resampling). */
  sampleRate: number;
  hopSec: number;
  frames: FrameFeatures[];
  voicedRatio: number;
  /** Seconds of voiced singing. */
  voicedSec: number;
  pitch: {
    medianMidi: number | null;
    /** 5th / 95th percentile of voiced MIDI, rounded to nearest note. */
    lowMidi: number | null;
    highMidi: number | null;
    /** 25th / 75th percentile — where the take mostly sits. */
    tessituraLowMidi: number | null;
    tessituraHighMidi: number | null;
    /** Global tuning offset in cents relative to A4 = a4Hz (the singer may be consistently sharp/flat). */
    tuningOffsetCents: number;
  };
  passaggio: PassaggioZone;
  /** Medians over voiced frames. */
  tone: {
    h1h2Db: number | null;
    alphaRatioDb: number | null;
    centroidHz: number | null;
    tiltDbPerOct: number | null;
    cppDb: number | null;
    hnrDb: number | null;
  };
  /** Register shares over ALL voiced frames (upper-range shares live in `style`). */
  registerShares: { chest: number; mix: number; head: number };
  notes: NoteSegment[];
  phrases: Phrase[];
  onsets: Onset[];
  runs: Run[];
  style: StyleVector;
  quality: AudioQuality;
  /** Human-readable problems with the recording itself (too short, clipping, noisy, too quiet...). */
  warnings: string[];
  /** The same problems as machine-readable codes (one code may cover several warnings). */
  issues: AnalysisIssue[];
}

// ---------------------------------------------------------------------------------------------
// Singer profiles and comparison

/**
 * Target for one style dimension. Inside [low, high] counts as on-style; `ideal` is the sweet spot.
 * `tolerance` is how far outside the band (in the dimension's own units) the score falls to ~0.
 * `weight` is the dimension's importance to this singer's sound (0..1).
 */
export interface TargetBand {
  ideal: number;
  low: number;
  high: number;
  tolerance: number;
  weight: number;
}

export interface SignatureMove {
  id: string;
  name: string;
  description: string;
  howTo: string[];
}

export interface SingerProfile {
  id: string;
  name: string;
  /** One line shown on the singer card. */
  tagline: string;
  /** A short paragraph describing the sound. */
  description: string;
  /** Bullet-point traits. */
  traits: string[];
  /** Songs worth studying and what to listen for in each. */
  studySongs: { title: string; listenFor: string }[];
  /** Approximate range as MIDI numbers (for display and transposition advice). */
  typicalRange: { lowMidi: number; highMidi: number; tessituraLowMidi: number; tessituraHighMidi: number };
  targets: Partial<Record<StyleKey, TargetBand>>;
  signatureMoves: SignatureMove[];
  /** Hex colour used for this singer in the UI. */
  color: string;
  /**
   * 'builtin' = hand-authored estimate; 'measured' = a builtin singer whose targets were measured from
   * clips of that singer the user added; 'reference' = measured from a single reference clip.
   */
  source: 'builtin' | 'measured' | 'reference';
  /** Caveat shown in the UI about how the targets were derived. */
  sourceNote: string;
}

export type Direction = 'more' | 'less' | 'ok' | 'unknown';

export interface DimensionResult {
  key: StyleKey;
  label: string;
  /** The user's value, null if not measurable in this take. */
  value: number | null;
  target: TargetBand;
  /** 0..100 closeness to target. */
  score: number;
  /** What the user should do: 'more' = raise this dimension, 'less' = lower it. */
  direction: Direction;
  /** Short plain-English readout, e.g. "Airier than Daniel's tone (0.42 vs ~0.70)". */
  summary: string;
}

export interface Comparison {
  profileId: string;
  /** 0..100 weighted match. */
  overall: number;
  dimensions: DimensionResult[];
  /** Semitones to move the song so it sits in the user's range the way it sits in the singer's (negative = lower). */
  suggestedTransposeSemitones: number;
  /** Plain-English note about range fit. */
  rangeNote: string;
}

export interface Exercise {
  id: string;
  name: string;
  /** What it trains, one sentence. */
  goal: string;
  /** Style dimensions it helps with. */
  helps: StyleKey[];
  steps: string[];
  durationMin: number;
  /** Optional pitch pattern the practice player can play, relative to a start note. */
  pattern?: {
    kind: 'scale' | 'arpeggio' | 'siren' | 'sustain';
    /** Semitone offsets from the start note, in order. For 'siren', [low, high] glide bounds. */
    steps: number[];
    /** Beats per minute; each step is one beat. */
    bpm: number;
    /** Start note relative to the passaggio low note of the user's voice type (e.g. -7 = a fifth below). */
    startOffsetFromPassaggio: number;
    /** Transpose up by this many semitones each repetition. */
    stepUpSemitones: number;
    repetitions: number;
  };
  cautions?: string[];
}

export interface CoachingItem {
  id: string;
  /** 1 = work on this first. */
  priority: 1 | 2 | 3;
  dimension: StyleKey | 'range' | 'recording';
  title: string;
  /** What the analysis heard, in plain language with the numbers. */
  whatWeHeard: string;
  /** Why it matters for this singer's sound. */
  whyItMatters: string;
  /** Concrete technique cues. */
  howToFix: string[];
  exerciseIds: string[];
}

export interface CoachingPlan {
  profileId: string;
  /** Two or three sentences summarising the take against the target. */
  headline: string;
  strengths: string[];
  items: CoachingItem[];
  /** Signature moves of the target singer worth practising next, with personalised hints. */
  signatureFocus: { moveId: string; hint: string }[];
  /** Vocal-health notes (strain signs, rest advice). Always non-empty. */
  healthNotes: string[];
  /** One sentence: what to record next session. */
  nextTake: string;
}

/**
 * The measurements of one clip of an artist (numbers only, never audio), kept so the app can build
 * that singer's targets from their real recordings instead of the hand-set estimates.
 */
export interface MeasuredClip {
  id: string;
  /** File name without extension. */
  name: string;
  /** ISO timestamp. */
  addedAt: string;
  durationSec: number;
  voicedSec: number;
  style: StyleVector;
  pitch: { lowMidi: number | null; highMidi: number | null; tessituraLowMidi: number | null; tessituraHighMidi: number | null };
}

// ---------------------------------------------------------------------------------------------
// Reference-clip mode (the user uploads a clip of the artist from their own library)

export interface ReferenceSegmentComparison {
  refStart: number;
  refEnd: number;
  userStart: number;
  userEnd: number;
  /** Mean absolute pitch difference after transposition, cents. */
  meanAbsCents: number;
  /** Signed mean difference (positive = user sharp). */
  meanSignedCents: number;
  /** Plain-English note for this segment. */
  note: string;
}

export interface ReferenceComparison {
  /** Semitones the user sang relative to the reference (e.g. -12 = an octave lower). */
  transposeSemitones: number;
  /** Aligned pitch pairs for plotting (user time, reference time, cents difference after transposition). */
  path: { userT: number; refT: number; centsDiff: number }[];
  meanAbsCents: number;
  /** Share of aligned voiced frames within 50 cents. */
  withinFiftyCents: number;
  segments: ReferenceSegmentComparison[];
  /** Style-vector differences, user minus reference, for dimensions both takes measured. */
  styleDiff: Partial<Record<StyleKey, number>>;
}

// ---------------------------------------------------------------------------------------------
// Persistence and settings

export interface SessionRecord {
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  profileId: string;
  profileName: string;
  overall: number;
  dimensionScores: Partial<Record<StyleKey, number>>;
  style: StyleVector;
  durationSec: number;
  label?: string;
}

export interface AppSettings {
  voiceType: VoiceType;
  a4Hz: number;
  /** User-supplied Anthropic API key for the optional AI coach; stored only in this browser. */
  anthropicApiKey: string | null;
  aiModel: string;
}
