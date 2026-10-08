// Importing a clip: decode (WAV parser, then the browser decoder, with the M4A brand retry; phone videos give their audio
// track), analyse once, classify (solo vocal, full song, speech, too little singing), segment into phrases (prepareClip),
// then store after the user's review (commitClip). Nothing is stored until commitClip; a clip is either fully stored or absent.

import { abortError, isAbortError } from '../analysis/abort';
import { MAX_ANALYSIS_SEC } from '../analysis/analyze';
import { analyzeWithRouting } from '../analysis/auto';
import { analyzeInWorker } from '../analysis/client';
import { leadExtractionOf } from '../analysis/mixMode';
import { mixReport, mixTrustBand, type MixConfidenceBand } from '../analysis/quality';
import { decodeAudioFile, isVideoFile, type DecodedTake, type DecodeOptions } from '../audio/decode';
import { chunkFramesFor, fingerprint as hashBytes, floatToInt16, MAX_STORE_RATE, sameSourceFile } from '../audio/pcm';
import { isolateVocal, type IsolateInput, type IsolateResult } from '../audio/separation/client';
import { keepScreenAwake, type ScreenWakeLock } from '../audio/wakeLock';
import { ARTIST_VOICE_TYPE } from '../coach/measured';
import { MODEL_SAMPLE_RATE } from '../dsp/separate/constants';
import { referenceUsability } from '../coach/reference';
import type { ClipStore } from '../storage/clips';
import { findRelinkCandidates, measuredFromClip } from '../storage/library';
import { markSplitEnded, markSplitStarted } from './splitMarker';
import type {
  AnalysisIssue,
  AnalysisOptions,
  AppSettings,
  ClipAnalysisSummary,
  ClipAudioInfo,
  ClipIsolation,
  ClipKind,
  ClipRecord,
  MeasuredClip,
  VoiceAnalysis,
} from '../types';
import {
  BAND_WARNING,
  ISOLATED_BAND_LEFT_WARNING,
  CLIPPING_WARNING,
  ISOLATED_VOCAL_WARNING,
  ISOLATE_NOT_FOR_MIX,
  MIX_REASON,
  NOISY_WARNING,
  NOT_FOR_TARGETS_MIX,
  NO_PHRASES_REASON,
  QUIET_WARNING,
  SPEECH_REASON,
  VOCAL_FORWARD_HINT,
  littleMixSingingReason,
  littleSingingContext,
  littleSingingReason,
  mixAutoFailedWarning,
} from './importCopy';
import { TRAINER_ANALYSIS_VERSION } from './phraseAnalysis';
import { resampleAsync } from './resampleAsync';
import {
  applyTrim,
  clampTrim,
  clipDifficulty,
  defaultTrim,
  phraseDifficulty,
  refreshPhrases,
  segmentPhrases,
  toPhraseRecords,
  visiblePhrases,
  type SegPhrase,
  type Trim,
} from './segment';

export { TRAINER_ANALYSIS_VERSION };

export interface ImportProgress {
  fileIndex: number;
  fileCount: number;
  name: string;
  phase: 'reading' | 'decoding' | 'downloading-model' | 'isolating' | 'analysing' | 'segmenting' | 'storing';
  /** 0..1 within the phase. */
  fraction: number;
  /** True for every report of a file that is being isolated first, so the screen uses the progress plan that has room for it. */
  isolating?: boolean;
  /** While isolating: seconds left, from the patches finished so far; null until the first one is done. */
  etaSec?: number | null;
}

/** One way of reading the clip: the analysis, the phrases found in it, and what to tell the user about it. */
export interface AnalysisView {
  kind: ClipKind;
  analysis: VoiceAnalysis;
  phrases: SegPhrase[];
  warnings: string[];
  blockers: string[];
}

type Views = Partial<Record<ClipKind, AnalysisView>>;

export interface PreparedClip {
  file: { name: string; size: number };
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  analysis: VoiceAnalysis;
  suggestedKind: ClipKind;
  /** Plain-English reasons to show before the user commits (mix detected, little singing, noisy...). */
  warnings: string[];
  /** Hard stops: the clip cannot be used at all (no singing). Undecodable or DRM files reject earlier with a message. */
  blockers: string[];
  phrases: SegPhrase[];
  fingerprint: string;
  /** Notes from decoding (stereo that cancels out, a long file cut to the analysis limit...). */
  notices: string[];

  // Additive (all optional, so older fixtures stay valid):
  /** The kind `analysis`, `phrases`, `warnings` and `blockers` belong to; absent means `suggestedKind`. */
  kind?: ClipKind;
  /** What the clip was analysed with; switching between solo and full song re-analyses with the same options. */
  options?: AnalysisOptions;
  /** A video's sound was used. */
  sourceKind?: 'audio' | 'video';
  /** Every reading computed so far, so switching back and forth is instant. */
  views?: Views;
  /** A vocal-only file for a full song: playback uses this clip, the phrases and measurements come from the stem. */
  stem?: PreparedClip;
  /** Set when `samples` are a vocal pulled out of the song by the isolation model: the clip is a solo reading of that vocal. */
  isolation?: ClipIsolation;
}

export interface CommitEdits {
  title: string;
  singerId: string | null;
  singerLabel: string;
  kind: ClipKind;
  phrases: SegPhrase[];
  /** Keep only this span of the file (seconds); the default is the span that contains singing. */
  trim?: { startSec: number; endSec: number };
  contributeToSinger: boolean;
  /** A second file holding the isolated vocal; playback uses the mix, analysis the stem. */
  vocalStem?: PreparedClip;
  /** The user ticked "this is a file I own or have the right to practise with". */
  ownedConfirmed: true;
}

/** Which part of a song to isolate. Times are seconds into the file (prepareClip) or into the audio already read (isolatePrepared). */
export interface IsolateRequest {
  /** Where the part starts (default 0). */
  startSec?: number;
  /** How much to take (default and ceiling MAX_ISOLATE_SEC). */
  maxSec?: number;
}

export interface ImportDeps {
  /** Pulls the vocal out of a song (the separation worker in the app, a fake in tests). */
  isolate(input: IsolateInput): Promise<IsolateResult>;
  decode(file: File, opts: DecodeOptions): Promise<DecodedTake>;
  analyze(samples: Float32Array, sampleRate: number, opts: AnalysisOptions, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<VoiceAnalysis>;
  now(): number;
  /** Keeps the screen on while a song is being split (a locked iPhone pauses the page). Default: the Screen Wake Lock, where it works. */
  keepAwake?(): ScreenWakeLock;
}

const DEFAULT_DEPS: ImportDeps = {
  keepAwake: () => keepScreenAwake(),
  isolate: (input) => isolateVocal(input),
  decode: (file, opts) => decodeAudioFile(file, opts),
  analyze: (samples, sampleRate, opts, onProgress, signal) => analyzeInWorker(samples, sampleRate, opts, onProgress, signal),
  now: () => Date.now(),
};

export interface PrepareOptions {
  /** Position in a batch, for the progress callback. */
  index?: number;
  count?: number;
  signal?: AbortSignal;
  deps?: Partial<ImportDeps>;
  /** Pull the vocal out of the song first and read that, as a solo vocal (prepareClip), instead of following the lead vocal of the mix. */
  isolate?: IsolateRequest;
}

/**
 * The most of a song that is split in one go. A phone runs the network at roughly a few times real time, so this keeps one run to
 * minutes; the analysis reads at most MAX_ANALYSIS_SEC anyway, and a clip longer than that would have an unanalysed tail.
 */
export const MAX_ISOLATE_SEC = Math.min(6 * 60, MAX_ANALYSIS_SEC);

/** Compressed files longer than this (by their header) are not opened: decoding needs hundreds of MB of samples. */
export const MAX_IMPORT_SOURCE_SEC = 15 * 60;
/** The stem and the song must be the same length to line up. */
export const STEM_TOLERANCE_SEC = 0.2;
/** A re-added file may be this much shorter than the clip's excerpt needs (the same limit storage/library.ts uses for lengths). */
const RELINK_TOLERANCE_SEC = 0.3;
/** A stripped-down clip shorter than this is not worth storing. */
const MIN_KEPT_SEC = 1;

// ---------------------------------------------------------------------------------------------
// Small helpers

export { isAbortError };

function randomHex(bytes: number): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const buf = new Uint8Array(bytes);
  if (c?.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newClipId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `clip-${randomHex(8)}`;
}

export function newPhraseId(): string {
  return `p-${randomHex(6)}`;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** The clip's default title: the file name without its extension. */
export function defaultTitle(fileName: string): string {
  return stripExtension(fileName).replace(/\s+/g, ' ').trim() || 'Untitled clip';
}

/** The kind the prepared clip's current reading belongs to. */
export function preparedKind(p: PreparedClip): ClipKind {
  return p.kind ?? p.suggestedKind;
}

/** The analysis that defines the phrases and measurements: the vocal-only stem when there is one. */
export function effectiveAnalysis(p: PreparedClip): VoiceAnalysis {
  return (p.stem ?? p).analysis;
}

/** The segmentation to start editing from. */
export function effectivePhrases(p: PreparedClip): SegPhrase[] {
  return (p.stem ?? p).phrases;
}

/** Reasons the clip cannot be saved: the stem's when one is attached, else the clip's own. */
export function blockersOf(p: PreparedClip): string[] {
  return p.stem ? p.stem.blockers : p.blockers;
}

function viewOf(p: PreparedClip): AnalysisView {
  return { kind: preparedKind(p), analysis: p.analysis, phrases: p.phrases, warnings: p.warnings, blockers: p.blockers };
}

function applyView(p: PreparedClip, view: AnalysisView, views: Views): PreparedClip {
  return { ...p, kind: view.kind, analysis: view.analysis, phrases: view.phrases, warnings: view.warnings, blockers: view.blockers, views };
}

function qualityWarnings(issues: AnalysisIssue[]): string[] {
  const out: string[] = [];
  if (issues.includes('noisy')) out.push(NOISY_WARNING);
  if (issues.includes('clipping')) out.push(CLIPPING_WARNING);
  if (issues.includes('too-quiet')) out.push(QUIET_WARNING);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Classification

/**
 * What the analysis says the clip is. `blocked` carries the reason (too little singing, speech) and the next step. A clip
 * that sounds like singing over instruments is `mix` (allowed, pitch and timing only); noise and clipping only warn.
 */
export function classifyClip(analysis: VoiceAnalysis): { kind: ClipKind | 'blocked'; reason: string | null } {
  const issues = analysis.issues ?? [];
  if (analysis.mode !== 'mix' && issues.includes('accompaniment')) return { kind: 'mix', reason: MIX_REASON };
  if (issues.includes('too-little-singing')) return { kind: 'blocked', reason: littleSingingReason(analysis.voicedSec, littleSingingContext(analysis)) };
  if (issues.includes('speech-like')) return { kind: 'blocked', reason: SPEECH_REASON };
  if (analysis.mode === 'mix') return { kind: 'mix', reason: MIX_REASON };
  return { kind: 'solo', reason: null };
}

/**
 * How sure Mimic is that it followed the lead vocal of a full song (null for a solo reading). A ranking, not a percentage of right notes.
 * The band word also weighs `purity` (how much of the line is probably the voice, not the band): a steady bass line scores a high
 * confidence, so a rough guide is never worded better than "hard to follow in places".
 */
export function leadConfidenceOf(analysis: VoiceAnalysis): { confidence: number; purity?: number; roughGuide: boolean; band: MixConfidenceBand } | null {
  const le = leadExtractionOf(analysis);
  if (!le) return null;
  const purity = le.purity;
  return { confidence: le.confidence, ...(purity === undefined ? {} : { purity }), roughGuide: le.roughGuide === true, band: mixTrustBand({ confidence: le.confidence, purity }) };
}

/** A reading of the analysis as the given kind: the phrases found, warnings to show and blockers that stop the save. */
export function buildView(kind: ClipKind, analysis: VoiceAnalysis): AnalysisView {
  const issues = analysis.issues ?? [];
  const warnings = qualityWarnings(issues);
  const blockers: string[] = [];
  if (kind === 'mix') {
    warnings.unshift(MIX_REASON);
    // Below 0.8 the extractor itself says it was hard to follow: say so before the user trusts the phrases.
    const lead = leadConfidenceOf(analysis);
    if (lead && analysis.mode === 'mix') warnings.splice(1, 0, ...mixReport({ confidence: lead.confidence, voicedSec: analysis.voicedSec, purity: lead.purity }).warnings);
  }
  if (kind === 'solo' && analysis.mode !== 'mix' && issues.includes('accompaniment')) warnings.unshift(BAND_WARNING);
  else if (kind === 'solo' && issues.includes('noisy')) {
    // A vocal-forward song (voice +6 dB or more over the band) reads as a solo with background noise; the instruments are the extra notes.
    const at = warnings.indexOf(NOISY_WARNING);
    if (at >= 0) warnings[at] = `${NOISY_WARNING} ${VOCAL_FORWARD_HINT}`;
  }
  if (issues.includes('too-little-singing')) blockers.push(kind === 'mix' && analysis.mode === 'mix' ? littleMixSingingReason(analysis.voicedSec) : littleSingingReason(analysis.voicedSec, littleSingingContext(analysis)));
  else if (issues.includes('speech-like') && kind === 'solo') blockers.push(SPEECH_REASON);
  let phrases: SegPhrase[] = [];
  if (blockers.length === 0) {
    phrases = segmentPhrases(analysis);
    if (phrases.length === 0) blockers.push(NO_PHRASES_REASON);
  }
  return { kind, analysis, phrases, warnings, blockers };
}

/** The full-song reading, from the analysis entry point with `mode: 'mix'`. A result that is not a mix analysis is an error, never passed off as one. */
async function analyzeMixReading(
  analyze: ImportDeps['analyze'],
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<VoiceAnalysis> {
  const analysis = await analyze(samples, sampleRate, { ...opts, mode: 'mix' }, onProgress, signal);
  if (analysis.mode !== 'mix') throw new Error('The full-song reading did not run. Reload the app and try again, or add the vocal-only version of the song.');
  return analysis;
}

// ---------------------------------------------------------------------------------------------
// prepareClip

async function readFingerprint(file: Blob, durationSec: number): Promise<string> {
  let bytes: Uint8Array = new Uint8Array(0);
  try {
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const tail = file.size > 65536 ? new Uint8Array(await file.slice(Math.max(65536, file.size - 65536)).arrayBuffer()) : new Uint8Array(0);
    bytes = new Uint8Array(head.length + tail.length);
    bytes.set(head, 0);
    bytes.set(tail, head.length);
  } catch {
    // An unreadable slice only weakens the fingerprint to size and length.
  }
  try {
    return await hashBytes(bytes, file.size, durationSec);
  } catch {
    // crypto.subtle is missing on plain-HTTP pages: fall back to a simple 52-bit hash of the same bytes.
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 2654435761);
      h2 = Math.imul(h2 ^ bytes[i], 1597334677);
    }
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
    return `${file.size}:${Math.round(durationSec * 1000)}:${hex(h1)}${hex(h2)}`;
  }
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The part of a song to isolate, from a request: the start and the length, the length never above MAX_ISOLATE_SEC. */
export function isolatePart(request: IsolateRequest): { startSec: number; lengthSec: number } {
  const startSec = Number.isFinite(request.startSec) ? Math.max(0, request.startSec as number) : 0;
  const wanted = Number.isFinite(request.maxSec) && (request.maxSec as number) > 0 ? (request.maxSec as number) : MAX_ISOLATE_SEC;
  return { startSec, lengthSec: Math.min(wanted, MAX_ISOLATE_SEC) };
}

/** The solo reading of an isolated vocal. The song's band warning does not apply to it, and says the vocal was extracted. */
export function isolatedView(analysis: VoiceAnalysis): AnalysisView {
  const view = buildView('solo', analysis);
  const warnings = view.warnings.filter((w) => w !== BAND_WARNING).map((w) => w.replace(` ${VOCAL_FORWARD_HINT}`, ''));
  // "Switch on full song" is wrong advice for an extracted vocal, but a band that is still audible after the split must not go unsaid.
  const bandLeft = analysis.mode !== 'mix' && (analysis.issues ?? []).includes('accompaniment');
  return { ...view, warnings: [ISOLATED_VOCAL_WARNING, ...(bandLeft ? [ISOLATED_BAND_LEFT_WARNING] : []), ...warnings] };
}

type Reporter = (phase: ImportProgress['phase'], fraction: number, etaSec?: number | null) => void;

/**
 * Runs a long split with the screen kept on (taken first, while the tap that started it is fresh, as Safari requires) and a note left in
 * storage until it ends, so a page that iOS ends mid-split can say so at the next start (splitMarker.ts).
 */
async function guardedSplit<T>(deps: ImportDeps, info: { fileName: string; seconds: number }, run: () => Promise<T>): Promise<T> {
  let awake: ScreenWakeLock | null = null;
  try {
    awake = deps.keepAwake?.() ?? null;
  } catch {
    awake = null; // never let a refused lock stop the split
  }
  markSplitStarted(info);
  try {
    return await run();
  } finally {
    markSplitEnded();
    awake?.release();
  }
}

/** Added to a clip's notices when the browser would not keep the model, so it is downloaded again next time. */
export const MODEL_NOT_KEPT_NOTICE = 'Your phone would not keep the vocal model (it may be short of space, or this is a private window), so it will be downloaded again the next time you split a song.';

/**
 * Split `samples` (a song section) into its vocal and read the vocal as a solo. The song's samples are given to the worker when
 * `consume` is set (the caller no longer needs them); only the isolated vocal is kept.
 */
async function isolateAndRead(
  deps: ImportDeps,
  input: { samples: Float32Array; sampleRate: number; consume: boolean },
  opts: AnalysisOptions,
  report: Reporter,
  signal: AbortSignal | undefined,
): Promise<{ samples: Float32Array; sampleRate: number; view: AnalysisView; model: { name: string; version: string }; modelKept: boolean }> {
  // "Downloading the model" is reported only when a download really starts (the separator calls onDownload), never when the model is
  // already on the phone; the splitting step starts once the model is ready (the separator's first progress report).
  const result = await deps.isolate({
    samples: input.samples,
    sampleRate: input.sampleRate,
    consume: input.consume,
    signal,
    onDownload: (d) => report('downloading-model', d.fraction),
    onProgress: (p) => report('isolating', p.fraction, p.etaSec),
  });
  if (signal?.aborted) throw abortError('The import was cancelled.');
  report('isolating', 1, 0);
  report('analysing', 0);
  const auto = await analyzeWithRouting(deps.analyze, result.vocals, result.sampleRate, opts, 'solo', (f) => report('analysing', f), signal);
  if (signal?.aborted) throw abortError('The import was cancelled.');
  report('analysing', 1);
  return { samples: result.vocals, sampleRate: result.sampleRate, view: isolatedView(auto.analysis), model: result.model, modelKept: result.modelKept };
}

/**
 * The review's "Isolate the vocal" for a clip that is already read (typically one found to be a full song): the same split and
 * solo reading as prepareClip with `isolate`, from the samples in hand, so the file is not decoded again. The song's samples are
 * dropped once the vocal replaces them. A failed or cancelled run leaves `prepared` untouched.
 */
export async function isolatePrepared(
  prepared: PreparedClip,
  onProgress?: (p: ImportProgress) => void,
  options: PrepareOptions & { part?: IsolateRequest } = {},
): Promise<PreparedClip> {
  if (prepared.isolation) return prepared;
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const part = isolatePart(options.part ?? {});
  const report: Reporter = (phase, fraction, etaSec) =>
    onProgress?.({
      fileIndex: options.index ?? 0,
      fileCount: options.count ?? 1,
      name: prepared.file.name,
      phase,
      fraction: Math.max(0, Math.min(1, fraction)),
      isolating: true,
      ...(etaSec !== undefined ? { etaSec } : {}),
    });
  const from = Math.min(prepared.samples.length, Math.round(part.startSec * prepared.sampleRate));
  const section = prepared.samples.subarray(from, Math.min(prepared.samples.length, from + Math.round(part.lengthSec * prepared.sampleRate)));
  if (section.length === 0) throw new Error('There is nothing to split at the start you chose. Choose an earlier start.');
  const opts = prepared.options ?? { voiceType: ARTIST_VOICE_TYPE, a4Hz: 440 };
  const isolated = await guardedSplit(deps, { fileName: prepared.file.name, seconds: section.length / prepared.sampleRate }, () =>
    isolateAndRead(deps, { samples: section, sampleRate: prepared.sampleRate, consume: false }, opts, report, options.signal),
  );
  report('segmenting', 1);
  return {
    ...prepared,
    ...(isolated.modelKept ? {} : { notices: [...prepared.notices, MODEL_NOT_KEPT_NOTICE] }),
    samples: isolated.samples,
    sampleRate: isolated.sampleRate,
    durationSec: isolated.samples.length / isolated.sampleRate,
    analysis: isolated.view.analysis,
    suggestedKind: 'solo',
    warnings: isolated.view.warnings,
    blockers: isolated.view.blockers,
    phrases: isolated.view.phrases,
    kind: 'solo',
    options: opts,
    views: { solo: isolated.view },
    stem: undefined,
    isolation: { model: isolated.model.name, version: isolated.model.version, sourceStartSec: part.startSec },
  };
}

/**
 * Decode, analyse and segment one file. Nothing is stored. Rejects with a message that names the fix (unreadable, protected,
 * too big, too long...); a readable file that cannot be used (no singing) resolves with `blockers`.
 */
export async function prepareClip(
  file: File,
  settings: AppSettings,
  onProgress?: (p: ImportProgress) => void,
  options: PrepareOptions = {},
): Promise<PreparedClip> {
  if (!options.isolate) return prepareClipRun(file, settings, onProgress, options);
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  return guardedSplit(deps, { fileName: file.name, seconds: isolatePart(options.isolate).lengthSec }, () => prepareClipRun(file, settings, onProgress, options));
}

async function prepareClipRun(
  file: File,
  settings: AppSettings,
  onProgress: ((p: ImportProgress) => void) | undefined,
  options: PrepareOptions,
): Promise<PreparedClip> {
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const part = options.isolate ? isolatePart(options.isolate) : null;
  // The phases of a file that is being isolated carry a flag, so the screen can show the plan that has room for the extra steps.
  const report: Reporter = (phase, fraction, etaSec) =>
    onProgress?.({
      fileIndex: options.index ?? 0,
      fileCount: options.count ?? 1,
      name: file.name,
      phase,
      fraction: Math.max(0, Math.min(1, fraction)),
      ...(part ? { isolating: true } : {}),
      ...(etaSec !== undefined ? { etaSec } : {}),
    });
  const check = () => {
    if (options.signal?.aborted) throw abortError('The import was cancelled.');
  };

  check();
  const video = isVideoFile(file);
  report('reading', 0);
  report('decoding', 0);
  // A song that is to be split is decoded at the separator's own rate, so a compressed file is not resampled 48 -> 44.1 -> 48 kHz.
  const decoded = await deps.decode(file, {
    maxSeconds: part ? part.startSec + part.lengthSec : MAX_ANALYSIS_SEC,
    maxSourceSec: MAX_IMPORT_SOURCE_SEC,
    ...(part ? { sampleRate: MODEL_SAMPLE_RATE } : {}),
  });
  check();
  const needsResample = decoded.sampleRate > MAX_STORE_RATE;
  report('decoding', needsResample ? 0.5 : 1);

  const notices = [...decoded.notices];
  if (video) notices.unshift('Used the sound of the video.');
  const decodedDurationSec = decoded.durationSec;
  let samples = decoded.samples;
  let sampleRate = decoded.sampleRate;
  if (part) {
    // Only the chosen part is kept: the rest of the song is let go now, not when the page next collects garbage.
    const from = Math.round(part.startSec * sampleRate);
    if (from >= samples.length) {
      throw new Error(`The start you chose (${formatClock(part.startSec)}) is past the end of this file (${formatClock(samples.length / sampleRate)}). Choose an earlier start.`);
    }
    samples = samples.slice(from, Math.min(samples.length, from + Math.round(part.lengthSec * sampleRate)));
    (decoded as { samples: Float32Array }).samples = new Float32Array(0);
    const total = decoded.sourceDurationSec;
    if (part.startSec > 0 || total > part.startSec + part.lengthSec + 1) {
      notices.push(
        `Only ${formatClock(part.startSec)} to ${formatClock(part.startSec + samples.length / sampleRate)} of ${file.name} (${(total / 60).toFixed(1)} minutes long) was split into a vocal. The rest was left out.`,
      );
    }
  } else if (decoded.sourceDurationSec > MAX_ANALYSIS_SEC + 1) {
    notices.push(
      `Only the first ${MAX_ANALYSIS_SEC / 60} minutes of ${file.name} (${(decoded.sourceDurationSec / 60).toFixed(1)} minutes long) were used. Trim long files to the part you want to practise.`,
    );
  }
  if (needsResample) {
    // A 96 kHz file would freeze the page for seconds in one call: convert it in slices, with progress.
    samples = await resampleAsync(samples, sampleRate, MAX_STORE_RATE, { signal: options.signal, onProgress: (f) => report('decoding', 0.5 + 0.5 * f) });
    sampleRate = MAX_STORE_RATE;
    check();
    report('decoding', 1);
  }
  let durationSec = samples.length / sampleRate;
  const opts: AnalysisOptions = { voiceType: ARTIST_VOICE_TYPE, a4Hz: settings.a4Hz };

  if (part) {
    // Split the song, then read the vocal on its own as a solo: tone and singer measurement are allowed, with the isolation caveat.
    const isolated = await isolateAndRead(deps, { samples, sampleRate, consume: true }, opts, report, options.signal);
    check();
    report('segmenting', 1);
    const fingerprint = await readFingerprint(file, decodedDurationSec);
    check();
    durationSec = isolated.samples.length / isolated.sampleRate;
    return {
      file: { name: file.name, size: file.size },
      samples: isolated.samples,
      sampleRate: isolated.sampleRate,
      durationSec,
      analysis: isolated.view.analysis,
      suggestedKind: 'solo',
      warnings: isolated.view.warnings,
      blockers: isolated.view.blockers,
      phrases: isolated.view.phrases,
      fingerprint,
      notices: isolated.modelKept ? notices : [...notices, MODEL_NOT_KEPT_NOTICE],
      kind: 'solo',
      options: opts,
      sourceKind: video ? 'video' : 'audio',
      views: { solo: isolated.view },
      isolation: { model: isolated.model.name, version: isolated.model.version, sourceStartSec: part.startSec },
    };
  }

  // Solo first (it is what finds out whether this is a song). When it raises the band issue the same audio is read again as a
  // full song, through the same analyzer (the worker in the app), with one progress stream.
  report('analysing', 0);
  const auto = await analyzeWithRouting(deps.analyze, samples, sampleRate, opts, 'auto', (f) => report('analysing', f), options.signal);
  check();
  const solo = auto.solo ?? auto.analysis;
  const verdict = classifyClip(solo);

  let views: Views;
  let current: AnalysisView;
  // An analyzer that hands back a plain solo reading for a full-song request has not run the full-song front end: treat it as failed.
  const mixFailure = auto.route === 'mix-auto' && auto.analysis.mode !== 'mix' ? 'The full-song reading did not run' : auto.mixError;
  if (auto.route === 'mix-auto' && mixFailure === null) {
    const soloView = buildView('solo', solo);
    const mixView = buildView('mix', auto.analysis);
    views = { solo: soloView, mix: mixView };
    current = mixView;
  } else {
    current = buildView('solo', solo);
    // The band was found but the full-song pass failed: show the solo reading with the reason, and let the toggle try again.
    if (mixFailure !== null) current = { ...current, warnings: [mixAutoFailedWarning(mixFailure), ...current.warnings.filter((w) => w !== BAND_WARNING)] };
    views = { solo: current };
  }
  report('analysing', 1);
  report('segmenting', 1);

  const fingerprint = await readFingerprint(file, decodedDurationSec);
  check();

  return {
    file: { name: file.name, size: file.size },
    samples,
    sampleRate,
    durationSec,
    analysis: current.analysis,
    suggestedKind: verdict.kind === 'mix' ? 'mix' : 'solo',
    warnings: current.warnings,
    blockers: current.blockers,
    phrases: current.phrases,
    fingerprint,
    notices,
    kind: current.kind,
    options: opts,
    sourceKind: video ? 'video' : 'audio',
    views,
  };
}

/**
 * Switch a prepared clip between "solo vocal" and "full song" (the review's toggle): the other reading is computed once (the
 * full-song front end for 'mix') and kept, so switching back is instant. Phrases are re-detected; the caller drops edits.
 */
export async function reanalyzeClip(
  prepared: PreparedClip,
  kind: ClipKind,
  onProgress?: (p: ImportProgress) => void,
  options: PrepareOptions = {},
): Promise<PreparedClip> {
  if (preparedKind(prepared) === kind) return prepared;
  if (prepared.isolation && kind === 'mix') throw new Error(ISOLATE_NOT_FOR_MIX);
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const views: Views = { ...prepared.views, [preparedKind(prepared)]: viewOf(prepared) };
  let view = views[kind];
  if (!view) {
    const opts = prepared.options ?? { voiceType: ARTIST_VOICE_TYPE, a4Hz: 440 };
    const report = (fraction: number) =>
      onProgress?.({ fileIndex: options.index ?? 0, fileCount: options.count ?? 1, name: prepared.file.name, phase: 'analysing', fraction });
    report(0);
    if (kind === 'mix') {
      view = buildView('mix', await analyzeMixReading(deps.analyze, prepared.samples, prepared.sampleRate, opts, report, options.signal));
    } else {
      const solo = await deps.analyze(prepared.samples, prepared.sampleRate, opts, report, options.signal);
      view = buildView('solo', solo);
    }
    if (options.signal?.aborted) throw abortError('The import was cancelled.');
    views[kind] = view;
  }
  return applyView(prepared, view, views);
}

/**
 * The stem as a solo reading. A file the user calls "the vocal on its own" is read as one even when it still sounds like it has
 * instruments in it (its solo reading carries that as a warning); null when no solo reading exists for it.
 */
export function normalizeStem(stem: PreparedClip): PreparedClip | null {
  if (preparedKind(stem) === 'solo') return stem;
  const solo = stem.views?.solo;
  return solo ? applyView({ ...stem, stem: undefined }, solo, { ...stem.views, [preparedKind(stem)]: viewOf(stem) }) : null;
}

/** Why a vocal-only file cannot be paired with this clip, or null when it can. */
export function stemProblem(mix: PreparedClip, stem: PreparedClip): string | null {
  const diff = Math.abs(stem.durationSec - mix.durationSec);
  if (diff > STEM_TOLERANCE_SEC) {
    return `The vocal-only file is ${stem.durationSec.toFixed(1)} s long but the song is ${mix.durationSec.toFixed(1)} s. They must be the same length (within ${STEM_TOLERANCE_SEC} s) to line up. Pick the vocal file for this exact version of the song.`;
  }
  const solo = normalizeStem(stem);
  if (!solo) return 'This file could not be read as a single voice. Pick the isolated vocal (a cappella) version of this song.';
  if (solo.blockers.length > 0) return solo.blockers[0];
  return null;
}

/** The clip with the vocal-only file attached (it must pass `stemProblem`). */
export function withVocalStem(mix: PreparedClip, stem: PreparedClip): PreparedClip {
  const problem = stemProblem(mix, stem);
  if (problem) throw new Error(problem);
  return { ...mix, stem: normalizeStem(stem) as PreparedClip };
}

export function withoutVocalStem(mix: PreparedClip): PreparedClip {
  const { stem: _stem, ...rest } = mix;
  return rest;
}

/** Whether the clip can count toward its singer's measured targets, and if not, why (for the review's one-tap choice). */
export function targetEligibility(prepared: PreparedClip, kind: ClipKind): { eligible: boolean; reason: string | null } {
  if (kind === 'mix') return { eligible: false, reason: NOT_FOR_TARGETS_MIX };
  const usable = referenceUsability(effectiveAnalysis(prepared));
  return { eligible: usable.usable, reason: usable.reason };
}

// ---------------------------------------------------------------------------------------------
// commitClip

/** "size:durationMs:hash" of the source file, plus "@startMs" when only an excerpt starting there was stored. */
function withTrimStart(fingerprint: string, startSec: number): string {
  const base = sourceFingerprint(fingerprint);
  return startSec > 0.0005 ? `${base}@${Math.round(startSec * 1000)}` : base;
}

/** The source-file part of a clip fingerprint (without the excerpt offset). */
export function sourceFingerprint(fingerprint: string): string {
  const at = fingerprint.indexOf('@');
  return at < 0 ? fingerprint : fingerprint.slice(0, at);
}

/** Where in the source file the stored excerpt starts, seconds (0 for a clip stored whole). */
export function trimStartOf(fingerprint: string): number {
  const at = fingerprint.indexOf('@');
  if (at < 0) return 0;
  const ms = Number(fingerprint.slice(at + 1));
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

/** True when both fingerprints are of the same source file (same size and content; the decoded length may differ by a few ms). */
export function sameSource(a: string, b: string): boolean {
  return sameSourceFile(a, b);
}

function voicedSecIn(analysis: VoiceAnalysis, startSec: number, endSec: number): number {
  const hop = analysis.hopSec > 0 ? analysis.hopSec : 0.01;
  let n = 0;
  for (const f of analysis.frames) if (f.voiced && f.t >= startSec && f.t < endSec) n++;
  return n * hop;
}

function mixSummaryFields(analysis: VoiceAnalysis): Pick<ClipAnalysisSummary, 'leadConfidence' | 'leadPurity'> {
  const le = leadExtractionOf(analysis);
  return { leadConfidence: le?.confidence ?? null, ...(le?.purity === undefined ? {} : { leadPurity: le.purity }) };
}

function summaryOf(analysis: VoiceAnalysis, opts: AnalysisOptions, kind: ClipKind, trimmed: { startSec: number; endSec: number }): ClipAnalysisSummary {
  const usable = kind === 'mix' ? { usable: false, reason: NOT_FOR_TARGETS_MIX } : referenceUsability(analysis);
  const p = analysis.pitch;
  return {
    analysisVersion: TRAINER_ANALYSIS_VERSION,
    voiceType: opts.voiceType,
    a4Hz: opts.a4Hz ?? 440,
    durationSec: trimmed.endSec - trimmed.startSec,
    voicedSec: voicedSecIn(analysis, trimmed.startSec, trimmed.endSec),
    style: { ...analysis.style },
    pitch: { medianMidi: p.medianMidi, lowMidi: p.lowMidi, highMidi: p.highMidi, tessituraLowMidi: p.tessituraLowMidi, tessituraHighMidi: p.tessituraHighMidi },
    issues: [...(analysis.issues ?? [])],
    usableAsTarget: usable.usable,
    unusableReason: usable.usable ? null : usable.reason,
    ...(analysis.mode === 'mix' ? mixSummaryFields(analysis) : {}),
  };
}

function excerpt(samples: Float32Array, sampleRate: number, trim: Trim): { pcm: Int16Array; startFrame: number; endFrame: number } {
  const startFrame = Math.max(0, Math.min(samples.length, Math.round(trim.startSec * sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(samples.length, Math.round(trim.endSec * sampleRate)));
  return { pcm: floatToInt16(samples.subarray(startFrame, endFrame)), startFrame, endFrame };
}

/** Bytes the clip will take on the device once stored (Int16 mono), for the "needs about N MB" line and the quota check. */
export function estimateStoredBytes(prepared: PreparedClip, trim: Trim, withStem = !!prepared.stem): number {
  const frames = (p: PreparedClip) => Math.max(0, Math.round((trim.endSec - trim.startSec) * p.sampleRate));
  return frames(prepared) * 2 + (withStem && prepared.stem ? frames(prepared.stem) * 2 : 0);
}

/**
 * Store a reviewed clip: the kept span of the audio as Int16 PCM (the stem too, when there is one) and the clip record with
 * its phrases. Either everything is stored or nothing is (audio written for a clip that then fails to save is removed).
 * Returns the MeasuredClip when the clip should count toward its singer's targets; the caller adds it to the app.
 */
export async function commitClip(
  prepared: PreparedClip,
  edits: CommitEdits,
  store: ClipStore,
  onProgress?: (p: ImportProgress) => void,
  options: PrepareOptions = {},
): Promise<{ clip: ClipRecord; measured: MeasuredClip | null }> {
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const report = (fraction: number) =>
    onProgress?.({ fileIndex: options.index ?? 0, fileCount: options.count ?? 1, name: prepared.file.name, phase: 'storing', fraction });
  if ((edits.ownedConfirmed as boolean) !== true) throw new Error('Confirm that this is a file you own or have the right to practise with before saving it.');

  let current = prepared;
  if (edits.kind !== preparedKind(current)) current = await reanalyzeClip(current, edits.kind, onProgress, options);
  if (current.isolation && edits.kind === 'mix') throw new Error(ISOLATE_NOT_FOR_MIX);
  const wantedStem = edits.kind === 'mix' ? (edits.vocalStem ?? current.stem ?? null) : null;
  if (wantedStem) {
    const problem = stemProblem(current, wantedStem);
    if (problem) throw new Error(problem);
  }
  const stem = wantedStem ? normalizeStem(wantedStem) : null;
  const blockers = stem ? stem.blockers : current.blockers;
  if (blockers.length > 0) throw new Error(blockers[0]);

  const analysis = (stem ?? current).analysis;
  const opts = current.options ?? { voiceType: ARTIST_VOICE_TYPE, a4Hz: 440 };
  const phrases = refreshPhrases(edits.phrases, analysis);
  if (visiblePhrases(phrases).length === 0) {
    throw new Error('Keep at least one phrase to practise: show a hidden phrase, or add the clip again with different phrases.');
  }

  // The kept span, snapped to whole sample frames of the song so the phrases line up with the stored audio.
  const wanted = clampTrim(edits.trim ?? defaultTrim(phrases, current.durationSec), current.durationSec, MIN_KEPT_SEC);
  const mixCut = excerpt(current.samples, current.sampleRate, wanted);
  const keptStart = mixCut.startFrame / current.sampleRate;
  const keptEnd = mixCut.endFrame / current.sampleRate;
  if (keptEnd - keptStart < MIN_KEPT_SEC - 1e-6) throw new Error('The part to keep is shorter than one second. Widen it and save again.');
  const trim: Trim = { startSec: keptStart, endSec: keptEnd };
  const kept = applyTrim(phrases, trim);
  if (visiblePhrases(kept).length === 0) throw new Error('No phrase is left inside the part you chose to keep. Widen it to include the singing.');

  const clipId = newClipId();
  const now = new Date(deps.now()).toISOString();
  const title = edits.title.trim() || defaultTitle(current.file.name);
  const records = toPhraseRecords(kept, analysis, newPhraseId, trim.startSec);
  const levels = visiblePhrases(kept).map((p) => phraseDifficulty(analysis, { voicedStart: p.voicedStart + trim.startSec, voicedEnd: p.voicedEnd + trim.startSec }).level);

  report(0.05);
  // The record goes in FIRST, marked as lacking its audio, then the audio, then the record again with the flag cleared. A page
  // that is killed half way (iOS does that to a busy tab) then leaves a clip that says "add the file again", which the app knows
  // how to finish, instead of megabytes of audio that no record owns and nobody can see or remove.
  const mixFrames = mixCut.pcm.length;
  const stemCut = stem ? excerpt(stem.samples, stem.sampleRate, trim) : null;
  const mixInfo: ClipAudioInfo = { kind: 'mix', sampleRate: current.sampleRate, frames: mixFrames, chunkFrames: chunkFramesFor(current.sampleRate) };
  const vocalInfo: ClipAudioInfo | null = stem && stemCut ? { kind: 'vocal', sampleRate: stem.sampleRate, frames: stemCut.pcm.length, chunkFrames: chunkFramesFor(stem.sampleRate) } : null;
  const summary = summaryOf(analysis, opts, edits.kind, trim);
  const measured = edits.contributeToSinger && edits.kind === 'solo' && edits.singerId !== null && summary.usableAsTarget;
  const pending: ClipRecord = {
    schema: 1,
    id: clipId,
    title,
    singerId: edits.singerId,
    singerLabel: edits.singerId === null ? edits.singerLabel.trim() : '',
    sourceFileName: current.file.name,
    sourceBytes: current.file.size,
    fingerprint: withTrimStart(current.fingerprint, trim.startSec),
    addedAt: now,
    updatedAt: now,
    durationSec: mixInfo.frames / mixInfo.sampleRate,
    kind: edits.kind,
    analysisKind: edits.kind === 'mix' && !stem ? 'mix-melody' : 'solo',
    audio: { mix: mixInfo, vocal: vocalInfo },
    audioMissing: true,
    analysis: summary,
    phrases: records,
    notes: '',
    tags: [],
    difficulty: clipDifficulty(levels),
    contributesToSinger: measured,
    ownedConfirmedAt: now,
    ...(current.isolation ? { isolation: { ...current.isolation } } : {}),
  };
  try {
    await store.putClip(pending);
    const wroteMix = await store.writeAudio(clipId, 'mix', mixCut.pcm, current.sampleRate);
    report(0.6);
    let wroteVocal: ClipAudioInfo | null = null;
    if (stemCut) {
      wroteVocal = await store.writeAudio(clipId, 'vocal', stemCut.pcm, (stem as PreparedClip).sampleRate);
      report(0.8);
    }
    const clip: ClipRecord = { ...pending, audio: { mix: wroteMix, vocal: wroteVocal }, durationSec: wroteMix.frames / wroteMix.sampleRate, audioMissing: false };
    await store.putClip(clip);
    report(1);
    // The same numbers a later "add to targets" tap builds from the stored clip (the kept excerpt's singing time is the weight),
    // so counting a clip at import and counting it afterwards give the same targets.
    return { clip, measured: measured ? measuredFromClip(clip) : null };
  } catch (err) {
    // Nothing half-stored: take back the record and whatever audio was written for it.
    await store.deleteClip(clipId).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// relinkAudio

/** Clips whose audio is missing that this file could be the source of (same fingerprint, or same name and source length). */
export function findRelinkMatches(clips: ClipRecord[], prepared: PreparedClip): ClipRecord[] {
  return findRelinkCandidates(clips, {
    fingerprint: prepared.fingerprint,
    fileName: prepared.file.name,
    durationSec: prepared.durationSec,
    ...(prepared.isolation ? { isolated: true } : {}),
  });
}

/**
 * The part of the song to split again to give an isolated clip its audio back: the same start as the first time, and just enough
 * length to cover the kept excerpt (its trim offset, its length and two seconds of margin), which can be much shorter than the
 * part that was split originally. Null for a clip that is not an isolated one.
 */
export function relinkIsolateRequest(clip: Pick<ClipRecord, 'isolation' | 'fingerprint' | 'durationSec'>): IsolateRequest | null {
  if (!clip.isolation) return null;
  return { startSec: clip.isolation.sourceStartSec, maxSec: Math.min(MAX_ISOLATE_SEC, Math.ceil(trimStartOf(clip.fingerprint) + clip.durationSec + 2)) };
}

/**
 * Re-attaches audio to a clip whose audio is missing (after a library import), keeping its phrases and history. The file must be
 * the one the clip came from (same fingerprint, or the same name and length); an excerpt is cut at the offset stored in the
 * fingerprint. A clip that had a vocal-only stem needs it again (`vocalStem`), else it falls back to analysing the full mix.
 */
export async function relinkAudio(clip: ClipRecord, prepared: PreparedClip, store: ClipStore, vocalStem?: PreparedClip): Promise<ClipRecord> {
  if (!clip.audioMissing) throw new Error(`"${clip.title}" already has its audio on this device.`);
  if (findRelinkMatches([clip], prepared).length === 0) {
    throw new Error(`This does not look like the file for "${clip.title}" (${clip.sourceFileName}). Pick the file you originally added, or add this one as a new clip.`);
  }
  if (clip.isolation && !prepared.isolation) {
    throw new Error(`"${clip.title}" is an isolated vocal, and this is the whole song, so its phrases would not line up. Add the song again with "Isolate the vocal first" switched on, starting at the same place (${formatClock(clip.isolation.sourceStartSec)}), or add it as a new clip.`);
  }
  if (clip.isolation && prepared.isolation && Math.abs(prepared.isolation.sourceStartSec - clip.isolation.sourceStartSec) > 0.5) {
    throw new Error(`"${clip.title}" was isolated from ${formatClock(clip.isolation.sourceStartSec)} in the song, but this one starts at ${formatClock(prepared.isolation.sourceStartSec)}. Isolate it again from ${formatClock(clip.isolation.sourceStartSec)}.`);
  }
  const startSec = trimStartOf(clip.fingerprint);
  const sr = prepared.sampleRate;
  const startFrame = Math.round(startSec * sr);
  const wantFrames = Math.round(clip.durationSec * sr);
  const endFrame = Math.min(prepared.samples.length, startFrame + wantFrames);
  if (endFrame - startFrame < wantFrames - Math.round(RELINK_TOLERANCE_SEC * sr)) {
    throw new Error(`This file is shorter than "${clip.title}" should be (${clip.durationSec.toFixed(1)} s from ${startSec.toFixed(1)} s in). Pick the original file.`);
  }
  const stemIssue = stemProblemFor(clip, prepared, vocalStem);
  if (stemIssue) throw new Error(stemIssue);

  const written: ('mix' | 'vocal')[] = [];
  try {
    const mixInfo = await store.writeAudio(clip.id, 'mix', floatToInt16(prepared.samples.subarray(startFrame, endFrame)), sr);
    written.push('mix');
    let vocal: ClipAudioInfo | null = null;
    if (clip.audio.vocal && vocalStem) {
      const vsr = vocalStem.sampleRate;
      const vStart = Math.round(startSec * vsr);
      vocal = await store.writeAudio(clip.id, 'vocal', floatToInt16(vocalStem.samples.subarray(vStart, Math.min(vocalStem.samples.length, vStart + Math.round(clip.durationSec * vsr)))), vsr);
      written.push('vocal');
    }
    const relinked: ClipRecord = {
      ...clip,
      audio: { mix: mixInfo, vocal },
      audioMissing: false,
      // Without its stem a full-song clip has only the mix to analyse phrases from.
      analysisKind: clip.kind === 'mix' && !vocal ? 'mix-melody' : clip.analysisKind,
      updatedAt: new Date().toISOString(),
    };
    await store.putClip(relinked);
    return relinked;
  } catch (err) {
    await Promise.all(written.map((k) => store.deleteAudio(clip.id, k).catch(() => undefined)));
    throw err;
  }
}

function stemProblemFor(clip: ClipRecord, prepared: PreparedClip, vocalStem?: PreparedClip): string | null {
  if (!vocalStem) return null;
  if (!clip.audio.vocal) return `"${clip.title}" was not added with a vocal-only file, so there is nothing to attach it to.`;
  return stemProblem(prepared, vocalStem);
}

// ---------------------------------------------------------------------------------------------
// renderContourTone

const TONE_PEAK = 0.35;
const TONE_HARMONICS: readonly [number, number][] = [
  [1, 1],
  [2, 0.5],
  [3, 0.25],
];
const TONE_NORM = TONE_PEAK / TONE_HARMONICS.reduce((s, [, a]) => s + a, 0);

/**
 * Renders the detected f0 contour as a tone so the user can hear what the app thinks the melody is. A fundamental alone is
 * inaudible on a phone speaker for a low voice, so two overtones are added (the ear still hears the contour's pitch). Pitch
 * and level are interpolated between frames, so there are no clicks; unvoiced stretches are silent. `range` renders only that
 * part of the clip (time 0 of the result is `range.startSec`).
 */
export function renderContourTone(analysis: VoiceAnalysis, sampleRate = 22050, range?: { startSec: number; endSec: number }): Float32Array {
  const frames = analysis.frames ?? [];
  const hop = analysis.hopSec > 0 ? analysis.hopSec : 0.01;
  if (frames.length === 0 || !(sampleRate > 0)) return new Float32Array(0);
  const firstT = Number.isFinite(frames[0].t) ? frames[0].t : 0;
  const total = Math.max(analysis.durationSec || 0, frames[frames.length - 1].t + hop);
  const t0 = range ? Math.max(0, range.startSec) : 0;
  const t1 = range ? Math.min(total, range.endSec) : total;
  const n = Math.max(0, Math.round((t1 - t0) * sampleRate));
  const out = new Float32Array(n);
  if (n === 0) return out;

  // Per frame: log-frequency (held across unvoiced stretches so the pitch glides rather than sweeps from nothing) and gain.
  const logF = new Float64Array(frames.length).fill(NaN);
  const gain = new Float64Array(frames.length);
  let last = NaN;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.voiced && f.f0 > 0 && Number.isFinite(f.f0)) {
      last = Math.log(Math.min(2000, Math.max(40, f.f0)));
      logF[i] = last;
      gain[i] = 1;
    } else {
      logF[i] = last;
    }
  }
  let next = NaN;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (Number.isFinite(logF[i]) && gain[i] === 1) next = logF[i];
    else if (!Number.isFinite(logF[i])) logF[i] = next;
  }

  let phase = 0;
  for (let s = 0; s < n; s++) {
    const pos = (t0 + s / sampleRate - firstT) / hop;
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(pos)));
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const w = Math.max(0, Math.min(1, pos - i0));
    const g = gain[i0] * (1 - w) + gain[i1] * w;
    if (g <= 0.0005 || !Number.isFinite(logF[i0]) || !Number.isFinite(logF[i1])) continue;
    const hz = Math.exp(logF[i0] * (1 - w) + logF[i1] * w);
    phase += (2 * Math.PI * hz) / sampleRate;
    let v = 0;
    for (const [h, a] of TONE_HARMONICS) v += a * Math.sin(h * phase);
    out[s] = g * TONE_NORM * v;
  }
  return out;
}
