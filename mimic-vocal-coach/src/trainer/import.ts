// Importing a clip: decode (WAV parser, then the browser decoder, with the M4A brand retry; phone videos give their audio
// track), analyse once, classify (solo vocal, full song, speech, too little singing), segment into phrases (prepareClip),
// then store after the user's review (commitClip). Nothing is stored until commitClip; a clip is either fully stored or absent.

import { MAX_ANALYSIS_SEC } from '../analysis/analyze';
import { analyzeInWorker } from '../analysis/client';
import { decodeAudioFile, isVideoFile, type DecodedTake, type DecodeOptions } from '../audio/decode';
import { fingerprint as hashBytes, floatToInt16, MAX_STORE_RATE } from '../audio/pcm';
import { ARTIST_VOICE_TYPE, clipFromAnalysis } from '../coach/measured';
import { referenceUsability } from '../coach/reference';
import { resample } from '../dsp/resample';
import type { ClipStore } from '../storage/clips';
import type {
  AnalysisIssue,
  AnalysisOptions,
  AppSettings,
  ClipAnalysisSummary,
  ClipAudioInfo,
  ClipKind,
  ClipRecord,
  MeasuredClip,
  VoiceAnalysis,
} from '../types';
import {
  BAND_WARNING,
  CLIPPING_WARNING,
  FULL_SONG_UNAVAILABLE,
  MIX_REASON,
  NOISY_WARNING,
  NOT_FOR_TARGETS_MIX,
  NO_PHRASES_REASON,
  QUIET_WARNING,
  SPEECH_REASON,
  littleSingingReason,
} from './importCopy';
import { TRAINER_ANALYSIS_VERSION } from './phraseAnalysis';
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
  phase: 'reading' | 'decoding' | 'analysing' | 'segmenting' | 'storing';
  /** 0..1 within the phase. */
  fraction: number;
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

export interface ImportDeps {
  decode(file: File, opts: DecodeOptions): Promise<DecodedTake>;
  analyze(samples: Float32Array, sampleRate: number, opts: AnalysisOptions, onProgress?: (fraction: number) => void): Promise<VoiceAnalysis>;
  now(): number;
}

const DEFAULT_DEPS: ImportDeps = {
  decode: (file, opts) => decodeAudioFile(file, opts),
  analyze: (samples, sampleRate, opts, onProgress) => analyzeInWorker(samples, sampleRate, opts, onProgress),
  now: () => Date.now(),
};

export interface PrepareOptions {
  /** Position in a batch, for the progress callback. */
  index?: number;
  count?: number;
  signal?: AbortSignal;
  deps?: Partial<ImportDeps>;
}

/** Compressed files longer than this (by their header) are not opened: decoding needs hundreds of MB of samples. */
export const MAX_IMPORT_SOURCE_SEC = 15 * 60;
/** The stem and the song must be the same length to line up. */
export const STEM_TOLERANCE_SEC = 0.2;
/** A re-added file matches a clip by name when the durations agree this closely. */
const RELINK_TOLERANCE_SEC = 0.3;
/** A stripped-down clip shorter than this is not worth storing. */
const MIN_KEPT_SEC = 1;

// ---------------------------------------------------------------------------------------------
// Small helpers

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The import was cancelled.', 'AbortError');
  const err = new Error('The import was cancelled.');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

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
  if (issues.includes('too-little-singing')) return { kind: 'blocked', reason: littleSingingReason(analysis.voicedSec) };
  if (issues.includes('speech-like')) return { kind: 'blocked', reason: SPEECH_REASON };
  if (analysis.mode === 'mix') return { kind: 'mix', reason: MIX_REASON };
  return { kind: 'solo', reason: null };
}

/** A reading of the analysis as the given kind: the phrases found, warnings to show and blockers that stop the save. */
export function buildView(kind: ClipKind, analysis: VoiceAnalysis): AnalysisView {
  const issues = analysis.issues ?? [];
  const warnings = qualityWarnings(issues);
  const blockers: string[] = [];
  if (kind === 'mix') warnings.unshift(MIX_REASON);
  if (kind === 'solo' && analysis.mode !== 'mix' && issues.includes('accompaniment')) warnings.unshift(BAND_WARNING);
  if (issues.includes('too-little-singing')) blockers.push(littleSingingReason(analysis.voicedSec));
  else if (issues.includes('speech-like') && kind === 'solo') blockers.push(SPEECH_REASON);
  let phrases: SegPhrase[] = [];
  if (blockers.length === 0) {
    phrases = segmentPhrases(analysis);
    if (phrases.length === 0) blockers.push(NO_PHRASES_REASON);
  }
  return { kind, analysis, phrases, warnings, blockers };
}

/** The reading used when full-song analysis is not available: stays blocked, with the way out. */
function mixUnavailableView(solo: VoiceAnalysis): AnalysisView {
  return { kind: 'mix', analysis: solo, phrases: [], warnings: [], blockers: [FULL_SONG_UNAVAILABLE] };
}

/**
 * Runs the full-song front end (lead-vocal melody extraction) through the normal analysis entry point with `mode: 'mix'`.
 * An analysis that comes back without `mode: 'mix'` means this build cannot do it yet (null): the caller shows
 * FULL_SONG_UNAVAILABLE instead of passing a plain solo analysis off as a mix.
 */
export async function analyzeAsMix(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
  analyze: ImportDeps['analyze'] = DEFAULT_DEPS.analyze,
): Promise<VoiceAnalysis | null> {
  const analysis = await analyze(samples, sampleRate, { ...opts, mode: 'mix' }, onProgress);
  return analysis.mode === 'mix' ? analysis : null;
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
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const report = (phase: ImportProgress['phase'], fraction: number) =>
    onProgress?.({ fileIndex: options.index ?? 0, fileCount: options.count ?? 1, name: file.name, phase, fraction: Math.max(0, Math.min(1, fraction)) });
  const check = () => {
    if (options.signal?.aborted) throw abortError();
  };

  check();
  const video = isVideoFile(file);
  report('reading', 0);
  report('decoding', 0);
  const decoded = await deps.decode(file, { maxSeconds: MAX_ANALYSIS_SEC, maxSourceSec: MAX_IMPORT_SOURCE_SEC });
  check();
  report('decoding', 1);

  const notices = [...decoded.notices];
  if (video) notices.unshift('Used the sound of the video.');
  if (decoded.sourceDurationSec > MAX_ANALYSIS_SEC + 1) {
    notices.push(
      `Only the first ${MAX_ANALYSIS_SEC / 60} minutes of ${file.name} (${(decoded.sourceDurationSec / 60).toFixed(1)} minutes long) were used. Trim long files to the part you want to practise.`,
    );
  }
  let samples = decoded.samples;
  let sampleRate = decoded.sampleRate;
  if (sampleRate > MAX_STORE_RATE) {
    samples = resample(samples, sampleRate, MAX_STORE_RATE);
    sampleRate = MAX_STORE_RATE;
  }
  const durationSec = samples.length / sampleRate;
  const opts: AnalysisOptions = { voiceType: ARTIST_VOICE_TYPE, a4Hz: settings.a4Hz };

  report('analysing', 0);
  const solo = await deps.analyze(samples, sampleRate, opts, (f) => report('analysing', f * 0.6));
  check();
  const verdict = classifyClip(solo);

  let views: Views;
  let current: AnalysisView;
  if (verdict.kind === 'mix') {
    const soloView = buildView('solo', solo);
    const mixAnalysis = await analyzeAsMix(samples, sampleRate, opts, (f) => report('analysing', 0.6 + f * 0.4), deps.analyze);
    check();
    const mixView = mixAnalysis ? buildView('mix', mixAnalysis) : mixUnavailableView(solo);
    views = { solo: soloView, mix: mixView };
    current = mixView;
  } else {
    current = buildView('solo', solo);
    views = { solo: current };
  }
  report('analysing', 1);
  report('segmenting', 1);

  const fingerprint = await readFingerprint(file, decoded.durationSec);
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
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...options.deps };
  const views: Views = { ...prepared.views, [preparedKind(prepared)]: viewOf(prepared) };
  let view = views[kind];
  if (!view) {
    const opts = prepared.options ?? { voiceType: ARTIST_VOICE_TYPE, a4Hz: 440 };
    const report = (fraction: number) =>
      onProgress?.({ fileIndex: options.index ?? 0, fileCount: options.count ?? 1, name: prepared.file.name, phase: 'analysing', fraction });
    report(0);
    if (kind === 'mix') {
      const mix = await analyzeAsMix(prepared.samples, prepared.sampleRate, opts, report, deps.analyze);
      const soloAnalysis = views.solo?.analysis ?? prepared.analysis;
      view = mix ? buildView('mix', mix) : mixUnavailableView(soloAnalysis);
    } else {
      const solo = await deps.analyze(prepared.samples, prepared.sampleRate, opts, report);
      view = buildView('solo', solo);
    }
    if (options.signal?.aborted) throw abortError();
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

/** True when both fingerprints are of the same source file. */
export function sameSource(a: string, b: string): boolean {
  return sourceFingerprint(a) === sourceFingerprint(b);
}

function voicedSecIn(analysis: VoiceAnalysis, startSec: number, endSec: number): number {
  const hop = analysis.hopSec > 0 ? analysis.hopSec : 0.01;
  let n = 0;
  for (const f of analysis.frames) if (f.voiced && f.t >= startSec && f.t < endSec) n++;
  return n * hop;
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
  const written: ('mix' | 'vocal')[] = [];
  let mixInfo: ClipAudioInfo;
  let vocalInfo: ClipAudioInfo | null = null;
  try {
    mixInfo = await store.writeAudio(clipId, 'mix', mixCut.pcm, current.sampleRate);
    written.push('mix');
    report(0.6);
    if (stem) {
      const stemCut = excerpt(stem.samples, stem.sampleRate, trim);
      vocalInfo = await store.writeAudio(clipId, 'vocal', stemCut.pcm, stem.sampleRate);
      written.push('vocal');
      report(0.8);
    }
    const summary = summaryOf(analysis, opts, edits.kind, trim);
    const measured = edits.contributeToSinger && edits.kind === 'solo' && edits.singerId !== null && summary.usableAsTarget;
    const clip: ClipRecord = {
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
      audioMissing: false,
      analysis: summary,
      phrases: records,
      notes: '',
      tags: [],
      difficulty: clipDifficulty(levels),
      contributesToSinger: measured,
      ownedConfirmedAt: now,
    };
    await store.putClip(clip);
    report(1);
    return { clip, measured: measured ? clipFromAnalysis(analysis, title, clipId, now) : null };
  } catch (err) {
    // Nothing half-stored: take back whatever audio was written for a clip that does not exist.
    await Promise.all(written.map((k) => store.deleteAudio(clipId, k).catch(() => undefined)));
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// relinkAudio

const stemOfName = (name: string): string => stripExtension(name).toLowerCase().trim();

/** Clips whose audio is missing that this file could be the source of (same fingerprint, or same name and length). */
export function findRelinkMatches(clips: ClipRecord[], prepared: PreparedClip): ClipRecord[] {
  return clips.filter((c) => {
    if (!c.audioMissing) return false;
    if (sameSource(c.fingerprint, prepared.fingerprint)) return true;
    return stemOfName(c.sourceFileName) === stemOfName(prepared.file.name) && Math.abs(c.durationSec - prepared.durationSec) <= RELINK_TOLERANCE_SEC;
  });
}

/**
 * Re-attaches audio to a clip whose audio is missing (after a library import), keeping its phrases and history. The file must be
 * the one the clip came from (same fingerprint, or the same name and length); an excerpt is cut at the offset stored in the
 * fingerprint. A clip that had a vocal-only stem needs it again (`vocalStem`), else it falls back to analysing the full mix.
 */
export async function relinkAudio(clip: ClipRecord, prepared: PreparedClip, store: ClipStore, vocalStem?: PreparedClip): Promise<ClipRecord> {
  if (!clip.audioMissing) throw new Error(`"${clip.title}" already has its audio on this device.`);
  const nameAndLength = stemOfName(clip.sourceFileName) === stemOfName(prepared.file.name) && Math.abs(clip.durationSec - prepared.durationSec) <= RELINK_TOLERANCE_SEC;
  if (!sameSource(clip.fingerprint, prepared.fingerprint) && !nameAndLength) {
    throw new Error(`This does not look like the file for "${clip.title}" (${clip.sourceFileName}). Pick the file you originally added, or add this one as a new clip.`);
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
