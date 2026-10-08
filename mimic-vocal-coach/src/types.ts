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
  /**
   * 'solo' (default, absent = solo): one voice on its own, the normal pipeline. 'mix': a full song with instruments;
   * the lead-vocal melody is extracted first and only pitch, timing, vibrato and loudness contour are measured
   * (see analysis/mixMode.ts).
   */
  mode?: 'solo' | 'mix';
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
  /**
   * How this analysis was made. Absent = 'solo'. 'mix' = lead-vocal extraction from a full song: the tone fields
   * (`tone`, `registerShares`, the tone and register entries of `style`, `onsets`) are empty and must not be shown or scored.
   */
  mode?: 'solo' | 'mix';
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
  /** Measured from a vocal pulled out of a song by the on-device model, so its tone numbers are estimates. Absent for a real isolated vocal. */
  isolated?: true;
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

// ---------------------------------------------------------------------------------------------
// Clip trainer: stored clips, phrases and attempts (see src/trainer/README.md)

/** 'solo' = isolated vocal or a cappella; 'mix' = a full song mix (vocal with instruments). */
export type ClipKind = 'solo' | 'mix';
/** How the clip's pitch/tone were measured: the normal single-voice analysis, or melody extraction from a mix (pitch and timing only). */
export type ClipAnalysisKind = 'solo' | 'mix-melody';

/** 'sing-along': the guide plays while you sing (headphones). 'turn-taking': listen, then sing. */
export type PlayMode = 'sing-along' | 'turn-taking';
/** 'free': a constant detune is removed and any key is fine. 'locked': keep the detune (a guide you can hear is audible). */
export type KeyMode = 'free' | 'locked';

export interface ClipAudioInfo {
  /** 'mix' = what the singer hears and follows; 'vocal' = an isolated stem used for analysis when there is one. */
  kind: 'mix' | 'vocal';
  /** Stored sample rate (the decoded rate, capped at 48000). Mono Int16 PCM in chunks of `chunkFrames`. */
  sampleRate: number;
  frames: number;
  chunkFrames: number;
}

/**
 * A clip whose audio is a vocal pulled out of a full song, on this device, by the optional isolation model (src/audio/separation).
 * Absent on every other clip. The isolated vocal is approximate: it carries artefacts, so tone numbers measured on it are estimates.
 */
export interface ClipIsolation {
  /** The model's name and version as its manifest gave them (public/models/vocal-isolation.json). */
  model: string;
  version: string;
  /** Where in the song file the isolated part starts, seconds (0 when it is the beginning). */
  sourceStartSec: number;
}

export interface ClipAnalysisSummary {
  analysisVersion: number;
  /** Voice type the clip was analysed as (coach/measured.ts ARTIST_VOICE_TYPE) and the tuning used. */
  voiceType: VoiceType;
  a4Hz: number;
  durationSec: number;
  voicedSec: number;
  style: StyleVector;
  pitch: { medianMidi: number | null; lowMidi: number | null; highMidi: number | null; tessituraLowMidi: number | null; tessituraHighMidi: number | null };
  issues: AnalysisIssue[];
  /** referenceUsability(): can this clip contribute to a singer's measured targets? */
  usableAsTarget: boolean;
  unusableReason: string | null;
  /** Full-song clips read by the lead-vocal extractor: how well it followed the voice, 0..1 (a ranking, calibrated on synthetic mixes). Absent for solo clips. */
  leadConfidence?: number | null;
  /** Full-song clips: the share (0..1) of the followed melody that is probably the lead voice, not the band. Absent when the extractor did not say. */
  leadPurity?: number;
}

export interface PhraseSummary {
  durationSec: number;
  voicedSec: number;
  medianMidi: number | null;
  lowMidi: number | null;
  highMidi: number | null;
  noteCount: number;
  hasVibrato: boolean;
  /** null for mix-melody clips (tone is not measured there). */
  style: StyleVector | null;
}

export interface PhraseSrsState {
  /** 0 = not mastered; 1..6 = rung on the review ladder (1, 3, 7, 14, 30, 60 days). */
  rung: number;
  dueAt: number | null;
  masteredAt: number | null;
}

export interface PhraseStats {
  attempts: number;
  fullSpeedAttempts: number;
  best: number | null;
  last: number | null;
  /** Overall scores of the last five attempts, oldest first. */
  recent: number[];
  lastAt: number | null;
}

export interface PhraseRecord {
  id: string;
  /** 0-based position in the clip. */
  index: number;
  /** Padded playback window, seconds in the clip. */
  start: number;
  end: number;
  /** First/last sung time inside the window. */
  voicedStart: number;
  voicedEnd: number;
  source: 'auto' | 'user';
  label: string;
  lyrics: string;
  /** Fragments and phrases the user hid; excluded from practice queues. */
  hidden: boolean;
  summary: PhraseSummary | null;
  /** Transposition (semitones) of the last scored attempt; passed to compareToReference as `transposeHint`. */
  keyHint: number | null;
  /** Preferred practice speed, 0.5..1. */
  rate: number;
  srs: PhraseSrsState;
  stats: PhraseStats;
}

export interface ClipRecord {
  /** Record schema version (see storage/clips.ts migrations). */
  schema: 1;
  id: string;
  title: string;
  /** Builtin singer id, or null for "someone else" (then `singerLabel` names them). */
  singerId: string | null;
  singerLabel: string;
  sourceFileName: string;
  sourceBytes: number;
  /** audio/pcm.ts fingerprint: re-links a re-imported file to this clip if the audio was lost. */
  fingerprint: string;
  addedAt: string;
  updatedAt: string;
  durationSec: number;
  kind: ClipKind;
  analysisKind: ClipAnalysisKind;
  audio: { mix: ClipAudioInfo; vocal: ClipAudioInfo | null };
  /** True after a library import (JSON) that carried no audio; the clip is listed but needs its file again. */
  audioMissing: boolean;
  analysis: ClipAnalysisSummary;
  phrases: PhraseRecord[];
  notes: string;
  tags: string[];
  difficulty: 1 | 2 | 3 | null;
  /** The clip's measurements are part of the singer's measured targets (MeasuredClip with the same id). */
  contributesToSinger: boolean;
  /** When the user confirmed the file is theirs. */
  ownedConfirmedAt: string;
  /** Set when `audio.mix` is an AI-isolated vocal rather than the file as it was (see ClipIsolation). Older clips never have it. */
  isolation?: ClipIsolation;
}

export interface AttemptNoteSummary {
  /** Index into the reference phrase's notes. */
  i: number;
  refName: string;
  userName: string | null;
  cents: number | null;
  onsetMs: number | null;
  durationDeltaMs: number | null;
  flags: string[];
}

export interface AttemptRecord {
  id: string;
  clipId: string;
  phraseId: string;
  /** ms since epoch. */
  at: number;
  mode: PlayMode;
  keyMode: KeyMode;
  /** Playback speed of the reference, 0.5..1. */
  rate: number;
  transposeSemitones: number;
  /** The scorer's sub-scores (0..100); `overall` is the one number shown. null = not measured. */
  scores: { overall: number; pitch: number; timing: number | null; tone: number | null; expression: number | null };
  /** How far the scores can be trusted (AttemptScore.trust.level). */
  trust: 'ok' | 'caution' | 'invalid';
  coverage: number;
  wrongNotes: number;
  syncOffsetMs: number | null;
  tempoRatio: number | null;
  /** 'wired' | 'bluetooth' | 'builtin' | 'unknown' (from the input device label) - for latency statistics. */
  route: string;
  notes: AttemptNoteSummary[];
  /** The attempt's own StyleVector (tone over time); numbers only. */
  style: StyleVector;
  tone: { key: string; diff: number }[];
  fixIds: string[];
  analysisVersion: number;
  /** True when "keep my recordings" was on and a rolling copy exists in the attemptAudio store. */
  hasAudio: boolean;
}

export interface LibraryExport {
  format: 'mimic-library';
  version: 1;
  exportedAt: string;
  /** Audio is never exported. */
  clips: ClipRecord[];
  attempts: AttemptRecord[];
  calibration: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Attempt scoring: the score authority (trainer/score/score.ts, scoreAttempt)

export type SkillKey = 'pitch' | 'timing' | 'tone' | 'expression';

export interface ScoreOptions {
  /** Default 'turn-taking' (the user sings after listening). In 'sing-along' the lag is reported against the schedule. */
  mode?: PlayMode;
  /** Default 'free'. */
  keyMode?: KeyMode;
  /** Playback rate of the reference (0.5..1.5, default 1). The expected user tempo ratio is 1 / rate. */
  rate?: number;
  /** Sing-along only: where reference time 0 was scheduled in the attempt's own clock (s), and the known system latency (ms). */
  refStartInCaptureSec?: number;
  latencyMs?: number;
  /** Override the skill weights (they are re-normalised over the skills that could be measured). */
  weights?: Partial<Record<SkillKey, number>>;
  /** Typical attempt-minus-reference offsets of THIS user's mic/room (see estimateToneBias), subtracted before judging tone. */
  toneBias?: Partial<Record<'breathiness' | 'brightness' | 'rasp', number>>;
  /** Treat the phrase as speech-like regardless of the reference's `issues`. */
  forceSpeech?: boolean;
  /** Inject a cached/alternative aligner (tests, performance). Defaults to compareToReference. */
  compare?: (attempt: VoiceAnalysis, ref: VoiceAnalysis) => ReferenceComparison;
}

export interface ScoreComponent {
  id: string;
  skill: SkillKey;
  label: string;
  /** 0..100, null when it could not be measured (and is then left out of the skill's average). */
  score: number | null;
  /** Weight inside the skill (before re-normalisation over measured components). */
  weight: number;
  /** The measured quantity in plain units, e.g. '22 cents mean abs', for display. */
  value?: string;
  /** Number of observations behind the score (notes, frames/10, pairs). */
  n?: number;
}

/** Per-note findings. The scorer emits all of them; the note table (NoteCompare) uses the same words. */
export type NoteFlag =
  | 'ok' | 'flat' | 'sharp' | 'wrong-note' | 'octave-displaced' | 'early' | 'late' | 'short' | 'long'
  | 'missed' | 'merged' | 'split' | 'ornament';

export interface NoteScore {
  refIndex: number;
  refStart: number;
  refEnd: number;
  /** Reference note in the user's key (after the transposition), e.g. "G3". */
  refName: string;
  matched: boolean;
  userIndex: number | null;
  userName: string | null;
  /** Signed cents after the key shift and constant detune were removed (+ = sharp). */
  cents: number | null;
  /** Unfolded distance of the attempt's note from the reference note (in the user's key), semitones: + = above. Shows an octave-displaced or far-off note as it is. */
  semitones: number | null;
  pitchScore: number | null;
  /** Signed ms after the global lag and tempo were removed (+ = late). */
  onsetMs: number | null;
  onsetScore: number | null;
  /** user duration / (tempo ratio x reference duration). */
  durRatio: number | null;
  durScore: number | null;
  /** (user level - phrase median) - (ref level - phrase median), dB. */
  levelDeltaDb: number | null;
  refVibrato: boolean;
  userVibrato: boolean | null;
  /** Contour (frame-level, vibrato removed) score of this note, 0..100. */
  contourScore: number | null;
  /** Ornament / run note: judged with wider tolerance and less weight. */
  ornament: boolean;
  flags: NoteFlag[];
}

/** One ranked "what to fix first" item from the scorer. */
export interface Fix {
  id: string;
  skill: SkillKey;
  title: string;
  /** What to do, in the app's safe-coaching voice. */
  advice: string;
  /** Estimated points the overall score would gain if this were fixed (0..100 scale). */
  gainPoints: number;
  /** Reference note indices involved. */
  notes: number[];
}

export interface AttemptScore {
  status: 'ok' | 'low-evidence' | 'no-match';
  /** 0..100 incl. the completeness factor; null when status is 'low-evidence'. */
  overall: number | null;
  /** Same, judged only on the part that was sung. */
  overallOnSung: number | null;
  skills: Record<SkillKey, number | null>;
  /** Effective weights after re-normalising over measured skills (sum 1). */
  weights: Record<SkillKey, number>;
  components: ScoreComponent[];
  /** Share of the reference's singing time that has a matched note, 0..1. */
  coverage: number;
  /** 1 when coverage >= 0.9, falling linearly to 0 at coverage 0. */
  completeness: number;
  kind: 'sung' | 'speech-like';
  /** Semitones the attempt is above the reference (integer, from compareToReference). */
  transposeSemitones: number;
  /** Constant detune left after the key shift (cents); removed in 'free' key mode. */
  keyOffsetCents: number;
  timing: {
    /** Global lag of the attempt behind the reference, ms (sing-along: against the schedule, minus latencyMs). null in turn-taking. */
    lagMs: number | null;
    /** User time per reference time divided by the expected value (1.0 = same tempo; > 1 slower/dragged). null when unmeasurable. */
    tempoRatio: number | null;
    onsetMadMs: number | null;
  };
  /** Time span of the attempt that was matched, s (the rest was ignored: lead-in, talking, tail). */
  matchedSpan: { start: number; end: number } | null;
  perNote: NoteScore[];
  /** Plain-English findings, most important first. */
  notes: string[];
  fixes: Fix[];
  trust: { level: 'ok' | 'caution' | 'invalid'; reasons: string[] };
  diagnostics: Record<string, number | string | boolean | null>;
}

// ---------------------------------------------------------------------------------------------
// Phrase comparison: what the practice screen shows for one attempt (trainer/compare.ts, comparePhrase)
//
// ONE overall score per attempt: `score` (the scorer's AttemptScore) is the authority for the overall number and the four
// sub-scores. `notes` (the per-note table), the sync/tempo model and `tone` (plain-words findings) come from the comparison
// layer. `scores` is a flat copy of the score's numbers for convenience; never compute a second overall.

export interface PlayTiming {
  mode: PlayMode;
  /** Playback rate of the reference (0.5..1). */
  rate: number;
  /** Where reference sample 0 (start of the phrase window) was scheduled, in the attempt's own clock (s). Sing-along only. */
  refStartInCaptureSec?: number;
  keyMode: KeyMode;
  /** Sing-along: known system latency in ms (click probe), subtracted from the reported lag. */
  latencyMs?: number;
}

export interface NoteCompare {
  refIndex: number;
  refStart: number;
  refEnd: number;
  /** Reference note in the singer's key (after the transposition), e.g. "G3". */
  refName: string;
  matched: boolean;
  /** Note the attempt held over this reference note, e.g. "E3". */
  userName: string | null;
  /** Signed cents, + = sharp, constant detune removed in 'free' key mode. */
  cents: number | null;
  /** + = late, after the sync offset (and drift, in turn-taking) is removed. null for merged / unmeasurable onsets. */
  onsetMs: number | null;
  /** + = held longer than the reference at the playback rate. */
  durationDeltaMs: number | null;
  refVibrato: boolean;
  userVibrato: boolean | null;
  /** (attempt level relative to its phrase median) minus (reference's), dB; + = louder than the original. */
  levelDeltaDb: number | null;
  refRegister: string | null;
  userRegister: string | null;
  /** Seconds from note start to vibrato start, attempt minus reference; + = later. */
  vibratoStartDeltaSec: number | null;
  flags: NoteFlag[];
}

/** A tone difference worth telling the singer about (attempt minus reference). */
export interface ToneFinding {
  key: 'breathiness' | 'brightness' | 'rasp' | 'vibratoPresence' | 'vibratoRateHz' | 'vibratoExtentCents' | 'vibratoStart' | 'onset' | 'register' | 'level';
  /** Signed difference in the key's own unit (index, Hz, cents, seconds, dB); 0 for onset/register. */
  diff: number;
  /** How far past its threshold, in thresholds (1 = just noticeable). Ranks the fixes. */
  strength: number;
  detail?: string;
}

export interface PhraseComparison {
  transposeSemitones: number;
  /** Constant detune left after the integer transposition (cents), median over notes. */
  biasCents: number;
  syncOffsetMs: number | null;
  syncConfidence: 'high' | 'low' | 'none';
  /** Sing-along: attempt clock / playback clock (>1 = dragged). Turn-taking: the singer's own tempo vs the reference. */
  tempoRatio: number | null;
  /** The per-note table (pitch, onset, length, level, vibrato per reference note). */
  notes: NoteCompare[];
  extraNotes: number;
  /** Share of reference singing time the attempt covers (the scorer's `coverage`). */
  coverage: number;
  withinFifty: number;
  tone: ToneFinding[];
  /** The score authority's full result (sub-scores, ranked fixes, trust, per-note scores). */
  score: AttemptScore;
  /** Flat copy of the authority's numbers: `overall` is 0 when status is 'low-evidence'. */
  scores: { overall: number; pitch: number; timing: number | null; tone: number | null; expression: number | null };
  base: ReferenceComparison;
  /** Sing-along only: the attempt follows the playback too closely to be a human (speaker bleed). */
  bleedSuspect: boolean;
}
