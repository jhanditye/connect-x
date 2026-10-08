// The clip library as data: export / import (JSON, never audio), field-by-field parsing of stored and imported records,
// merging an import into what is on the device, matching a re-imported file to a clip that lost its audio, and the small
// pure transforms the provider applies (an attempt updates its phrase's stats and review state; a clip becomes a MeasuredClip).
//
// Parsing follows storage/history.ts and measurements.ts: every field is checked, malformed entries are dropped with a
// warning, nothing is half-read, and a record written by a NEWER app version is refused rather than guessed at.

import { parseFingerprint, sameSourceFile } from '../audio/pcm';
import { afterAttempt, MIN_MASTER_RATE, type AttemptLite } from '../trainer/srs';
import type {
  AnalysisIssue,
  AttemptNoteSummary,
  AttemptRecord,
  ClipAnalysisKind,
  ClipAnalysisSummary,
  ClipAudioInfo,
  ClipKind,
  ClipRecord,
  KeyMode,
  LibraryExport,
  MeasuredClip,
  PhraseRecord,
  PhraseSrsState,
  PhraseStats,
  PhraseSummary,
  PlayMode,
  VoiceType,
} from '../types';
import { sanitizeStyle } from './history';
import { isRecord } from './local';

export const LIBRARY_FORMAT = 'mimic-library';
/** Version of the export file. Bump only with a reader for the old one. */
export const LIBRARY_VERSION = 1;
/** Version of the stored ClipRecord (ClipRecord.schema). Add a step to CLIP_MIGRATIONS when it changes. */
export const CLIP_SCHEMA = 1;

/** A backup bigger than this is not a Mimic backup (a year of daily practice is a few MB). */
export const MAX_IMPORT_BYTES = 60 * 1024 * 1024;
const MAX_IMPORT_CLIPS = 2000;
const MAX_IMPORT_ATTEMPTS = 200_000;
const MAX_PHRASES_PER_CLIP = 500;
const MAX_NOTES_PER_ATTEMPT = 128;
const MAX_TAGS = 20;
const WEEK_MS = 7 * 86_400_000;
/** Backup reminder: after this many attempts, or a week, whichever comes first. */
export const REMIND_AFTER_ATTEMPTS = 10;

// ---------------------------------------------------------------------------------------------
// Schema migrations

/** One step per version: steps[n] turns a version-n record into a version-(n+1) one. */
export type MigrationSteps = Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>>;

/** Steps for ClipRecord.schema. Empty while CLIP_SCHEMA is 1: add `1: (raw) => ({ ...raw, ... })` with the version bump, never edit an old step. */
export const CLIP_MIGRATIONS: MigrationSteps = {};
/** Steps for LibraryExport.version, applied to the whole file before its clips are read. */
export const LIBRARY_MIGRATIONS: MigrationSteps = {};

/** Runs the steps from `from` up to `to`. Throws when a step is missing, so a record is never read as a version it is not. */
export function migrateRecord(raw: Record<string, unknown>, from: number, to: number, steps: MigrationSteps): Record<string, unknown> {
  let record = raw;
  for (let v = from; v < to; v++) {
    const step = steps[v];
    if (!step) throw new Error(`No migration from version ${v} to ${v + 1}.`);
    record = step(record);
  }
  return record;
}

// ---------------------------------------------------------------------------------------------
// Small readers

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): number | null => (finite(x) ? x : null);
const intOr = (x: unknown, fallback: number, min: number, max: number): number => (finite(x) ? Math.min(max, Math.max(min, Math.round(x))) : fallback);
const clampNum = (x: unknown, fallback: number, min: number, max: number): number => (finite(x) ? Math.min(max, Math.max(min, x)) : fallback);
const text = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : fallback);
const iso = (x: unknown): string | null => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null);
const time = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

// Exhaustive by construction: a new AnalysisIssue / VoiceType without an entry here fails to compile.
const ISSUES: Record<AnalysisIssue, true> = { 'too-little-singing': true, accompaniment: true, 'speech-like': true, noisy: true, clipping: true, 'too-quiet': true, trimmed: true };
const VOICE_TYPES: Record<VoiceType, true> = { bass: true, baritone: true, tenor: true, alto: true, mezzo: true, soprano: true };
const isIssue = (x: unknown): x is AnalysisIssue => typeof x === 'string' && Object.hasOwn(ISSUES, x);
const isVoiceType = (x: unknown): x is VoiceType => typeof x === 'string' && Object.hasOwn(VOICE_TYPES, x);

// ---------------------------------------------------------------------------------------------
// Export

function jsonClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function cleanCalibration(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(x)) return out;
  for (const [k, v] of Object.entries(x)) if (k && finite(v)) out[k] = v;
  return out;
}

/**
 * The library as a JSON-ready object. Audio is never part of it (a clip record only describes its audio), and an exported
 * attempt never claims a recording because none travels with it.
 */
export function buildLibraryExport(clips: ClipRecord[], attempts: AttemptRecord[], calibration: Record<string, number>, now: Date = new Date()): LibraryExport {
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_VERSION,
    exportedAt: now.toISOString(),
    clips: clips.map((c) => jsonClone(c)),
    attempts: attempts.map((a) => ({ ...jsonClone(a), hasAudio: false })),
    calibration: cleanCalibration(calibration),
  };
}

/** mimic-library-2026-10-08.json, named for the person's own calendar day (a backup made at 9 pm in California is not "tomorrow"). */
export function exportFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `mimic-library-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

// ---------------------------------------------------------------------------------------------
// Records

function parseAudioInfo(x: unknown, kind: 'mix' | 'vocal'): ClipAudioInfo | null {
  if (!isRecord(x)) return null;
  const { sampleRate, frames, chunkFrames } = x;
  if (!finite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null;
  if (!finite(frames) || frames < 0 || !Number.isInteger(frames)) return null;
  if (!finite(chunkFrames) || chunkFrames < 1 || !Number.isInteger(chunkFrames)) return null;
  return { kind, sampleRate, frames, chunkFrames };
}

function parseAnalysis(x: unknown): ClipAnalysisSummary | null {
  if (!isRecord(x)) return null;
  const pitch = isRecord(x.pitch) ? x.pitch : {};
  return {
    analysisVersion: intOr(x.analysisVersion, 1, 0, 1000),
    voiceType: isVoiceType(x.voiceType) ? x.voiceType : 'tenor',
    a4Hz: clampNum(x.a4Hz, 440, 400, 480),
    durationSec: clampNum(x.durationSec, 0, 0, 1e6),
    voicedSec: clampNum(x.voicedSec, 0, 0, 1e6),
    style: sanitizeStyle(x.style),
    pitch: {
      medianMidi: numOrNull(pitch.medianMidi),
      lowMidi: numOrNull(pitch.lowMidi),
      highMidi: numOrNull(pitch.highMidi),
      tessituraLowMidi: numOrNull(pitch.tessituraLowMidi),
      tessituraHighMidi: numOrNull(pitch.tessituraHighMidi),
    },
    issues: Array.isArray(x.issues) ? [...new Set(x.issues.filter(isIssue))] : [],
    usableAsTarget: x.usableAsTarget === true,
    unusableReason: typeof x.unusableReason === 'string' && x.unusableReason ? x.unusableReason : null,
    ...(finite(x.leadConfidence) ? { leadConfidence: clampNum(x.leadConfidence, 0, 0, 1) } : {}),
    ...(finite(x.leadPurity) ? { leadPurity: clampNum(x.leadPurity, 0, 0, 1) } : {}),
  };
}

function parsePhraseSummary(x: unknown): PhraseSummary | null {
  if (!isRecord(x)) return null;
  return {
    durationSec: clampNum(x.durationSec, 0, 0, 1e5),
    voicedSec: clampNum(x.voicedSec, 0, 0, 1e5),
    medianMidi: numOrNull(x.medianMidi),
    lowMidi: numOrNull(x.lowMidi),
    highMidi: numOrNull(x.highMidi),
    noteCount: intOr(x.noteCount, 0, 0, 10_000),
    hasVibrato: x.hasVibrato === true,
    style: x.style === null || x.style === undefined ? null : sanitizeStyle(x.style),
  };
}

function parseSrs(x: unknown): PhraseSrsState {
  const s = isRecord(x) ? x : {};
  const rung = intOr(s.rung, 0, 0, 6);
  return { rung, dueAt: rung > 0 ? numOrNull(s.dueAt) : null, masteredAt: numOrNull(s.masteredAt) };
}

function parseStats(x: unknown): PhraseStats {
  const s = isRecord(x) ? x : {};
  const recent = Array.isArray(s.recent) ? s.recent.filter(finite).slice(-5) : [];
  return {
    attempts: intOr(s.attempts, 0, 0, 1e7),
    fullSpeedAttempts: intOr(s.fullSpeedAttempts, 0, 0, 1e7),
    best: numOrNull(s.best),
    last: numOrNull(s.last),
    recent,
    lastAt: numOrNull(s.lastAt),
  };
}

function parsePhrase(x: unknown, clipDuration: number): PhraseRecord | null {
  if (!isRecord(x)) return null;
  const { id, start, end } = x;
  if (typeof id !== 'string' || !id || !finite(start) || !finite(end)) return null;
  // A window may not run past the clip it belongs to (reads are clamped anyway; this keeps the editor's numbers honest).
  const e = clipDuration > 0 ? Math.min(end, clipDuration) : end;
  const s = Math.max(0, Math.min(start, e));
  if (!(e > s)) return null;
  return {
    id,
    index: 0, // renumbered by the caller once the list is sorted
    start: s,
    end: e,
    voicedStart: clampNum(x.voicedStart, s, s, e),
    voicedEnd: clampNum(x.voicedEnd, e, s, e),
    source: x.source === 'user' ? 'user' : 'auto',
    label: text(x.label),
    lyrics: text(x.lyrics),
    hidden: x.hidden === true,
    summary: parsePhraseSummary(x.summary),
    keyHint: finite(x.keyHint) ? Math.round(x.keyHint) : null,
    rate: clampNum(x.rate, 1, 0.5, 1),
    srs: parseSrs(x.srs),
    stats: parseStats(x.stats),
  };
}

export type ClipInspection = { ok: true; clip: ClipRecord } | { ok: false; reason: 'newer' | 'invalid'; title: string | null };

/**
 * Why a clip record was or was not accepted. A record whose `schema` is newer than this app's is never half-read; an older
 * one is brought up to date through `migrations` first.
 */
export function inspectClipRecord(input: unknown, migrations: MigrationSteps = CLIP_MIGRATIONS, target: number = CLIP_SCHEMA): ClipInspection {
  const label = isRecord(input) && typeof input.title === 'string' ? input.title : null;
  const invalid: ClipInspection = { ok: false, reason: 'invalid', title: label };
  if (!isRecord(input)) return invalid;
  let x: Record<string, unknown> = input;
  if (x.schema !== undefined) {
    if (!finite(x.schema) || x.schema < 1 || !Number.isInteger(x.schema)) return invalid;
    if (x.schema > target) return { ok: false, reason: 'newer', title: label };
    if (x.schema < target) {
      try {
        x = migrateRecord(x, x.schema, target, migrations);
      } catch {
        return invalid;
      }
    }
  }
  const { id, durationSec } = x;
  if (typeof id !== 'string' || !id || !finite(durationSec) || durationSec < 0) return invalid;
  const audio = isRecord(x.audio) ? x.audio : null;
  const mix = audio ? parseAudioInfo(audio.mix, 'mix') : null;
  const analysis = parseAnalysis(x.analysis);
  if (!mix || !analysis) return invalid;
  const vocal = audio ? parseAudioInfo(audio.vocal, 'vocal') : null;

  const phrases: PhraseRecord[] = [];
  const seen = new Set<string>();
  if (Array.isArray(x.phrases)) {
    for (const item of x.phrases.slice(0, MAX_PHRASES_PER_CLIP)) {
      const p = parsePhrase(item, durationSec);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        phrases.push(p);
      }
    }
  }
  phrases.sort((a, b) => a.start - b.start || a.end - b.end);
  phrases.forEach((p, i) => (p.index = i));

  const kind: ClipKind = x.kind === 'mix' ? 'mix' : 'solo';
  const analysisKind: ClipAnalysisKind = x.analysisKind === 'mix-melody' || x.analysisKind === 'solo' ? x.analysisKind : kind === 'mix' ? 'mix-melody' : 'solo';
  const addedAt = iso(x.addedAt) ?? iso(x.updatedAt) ?? new Date(0).toISOString();
  const tags = Array.isArray(x.tags) ? [...new Set(x.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TAGS) : [];
  const clip: ClipRecord = {
    schema: target as typeof CLIP_SCHEMA,
    id,
    title: text(x.title).trim() || 'Untitled clip',
    singerId: typeof x.singerId === 'string' && x.singerId ? x.singerId : null,
    singerLabel: text(x.singerLabel),
    sourceFileName: text(x.sourceFileName),
    sourceBytes: clampNum(x.sourceBytes, 0, 0, 1e12),
    fingerprint: text(x.fingerprint),
    addedAt,
    updatedAt: iso(x.updatedAt) ?? addedAt,
    durationSec,
    kind,
    analysisKind,
    audio: { mix, vocal },
    audioMissing: x.audioMissing === true,
    analysis,
    phrases,
    notes: text(x.notes),
    tags,
    difficulty: x.difficulty === 1 || x.difficulty === 2 || x.difficulty === 3 ? x.difficulty : null,
    contributesToSinger: x.contributesToSinger === true,
    ownedConfirmedAt: iso(x.ownedConfirmedAt) ?? addedAt,
  };
  return { ok: true, clip };
}

export function parseClipRecord(x: unknown): ClipRecord | null {
  const r = inspectClipRecord(x);
  return r.ok ? r.clip : null;
}

function parseAttemptNote(x: unknown): AttemptNoteSummary | null {
  if (!isRecord(x) || !finite(x.i) || typeof x.refName !== 'string') return null;
  return {
    i: Math.max(0, Math.round(x.i)),
    refName: x.refName,
    userName: typeof x.userName === 'string' ? x.userName : null,
    cents: numOrNull(x.cents),
    onsetMs: numOrNull(x.onsetMs),
    durationDeltaMs: numOrNull(x.durationDeltaMs),
    flags: Array.isArray(x.flags) ? x.flags.filter((f): f is string => typeof f === 'string') : [],
  };
}

export function parseAttemptRecord(x: unknown, opts: { dropAudio?: boolean } = {}): AttemptRecord | null {
  if (!isRecord(x)) return null;
  const { id, clipId, phraseId, at } = x;
  if (typeof id !== 'string' || !id || typeof clipId !== 'string' || !clipId || typeof phraseId !== 'string' || !phraseId || !finite(at)) return null;
  const sc = isRecord(x.scores) ? x.scores : null;
  if (!sc || !finite(sc.overall) || !finite(sc.pitch)) return null;
  const mode: PlayMode = x.mode === 'turn-taking' ? 'turn-taking' : 'sing-along';
  const keyMode: KeyMode = x.keyMode === 'locked' ? 'locked' : 'free';
  const trust = x.trust === 'caution' || x.trust === 'invalid' ? x.trust : 'ok';
  const tone: { key: string; diff: number }[] = [];
  if (Array.isArray(x.tone)) for (const t of x.tone) if (isRecord(t) && typeof t.key === 'string' && finite(t.diff)) tone.push({ key: t.key, diff: t.diff });
  const notes: AttemptNoteSummary[] = [];
  if (Array.isArray(x.notes)) {
    for (const n of x.notes.slice(0, MAX_NOTES_PER_ATTEMPT)) {
      const p = parseAttemptNote(n);
      if (p) notes.push(p);
    }
  }
  return {
    id,
    clipId,
    phraseId,
    at,
    mode,
    keyMode,
    rate: clampNum(x.rate, 1, 0.25, 2),
    transposeSemitones: finite(x.transposeSemitones) ? Math.round(x.transposeSemitones) : 0,
    scores: {
      overall: clampNum(sc.overall, 0, 0, 100),
      pitch: clampNum(sc.pitch, 0, 0, 100),
      timing: finite(sc.timing) ? clampNum(sc.timing, 0, 0, 100) : null,
      tone: finite(sc.tone) ? clampNum(sc.tone, 0, 0, 100) : null,
      expression: finite(sc.expression) ? clampNum(sc.expression, 0, 0, 100) : null,
    },
    trust,
    coverage: clampNum(x.coverage, 0, 0, 1),
    wrongNotes: intOr(x.wrongNotes, 0, 0, 1000),
    syncOffsetMs: numOrNull(x.syncOffsetMs),
    tempoRatio: numOrNull(x.tempoRatio),
    route: text(x.route, 'unknown'),
    notes,
    style: sanitizeStyle(x.style),
    tone,
    fixIds: Array.isArray(x.fixIds) ? x.fixIds.filter((f): f is string => typeof f === 'string') : [],
    analysisVersion: intOr(x.analysisVersion, 1, 0, 1000),
    hasAudio: opts.dropAudio ? false : x.hasAudio === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Import

export type LibraryParse = { ok: true; value: LibraryExport; warnings: string[] } | { ok: false; error: string };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Field-by-field validation: malformed entries are dropped with a warning; a newer `version` is refused. */
export function parseLibraryExport(input: unknown): LibraryParse {
  if (!isRecord(input) || input.format !== LIBRARY_FORMAT) return { ok: false, error: 'That file is not a Mimic library backup. Choose a file made with "Export my library".' };
  let json: Record<string, unknown> = input;
  if (!finite(json.version) || json.version < 1 || !Number.isInteger(json.version)) return { ok: false, error: 'This backup has no readable version, so it cannot be imported.' };
  if (json.version > LIBRARY_VERSION) {
    return { ok: false, error: `This backup was made by a newer version of Mimic (backup format ${json.version}). Update the app, then try again.` };
  }
  if (json.version < LIBRARY_VERSION) {
    try {
      json = migrateRecord(json, json.version, LIBRARY_VERSION, LIBRARY_MIGRATIONS);
    } catch {
      return { ok: false, error: `This backup (format ${json.version}) is from an old version of Mimic that this one can no longer read.` };
    }
  }
  const rawClips = Array.isArray(json.clips) ? json.clips : [];
  const rawAttempts = Array.isArray(json.attempts) ? json.attempts : [];
  if (rawClips.length > MAX_IMPORT_CLIPS || rawAttempts.length > MAX_IMPORT_ATTEMPTS) return { ok: false, error: 'This backup is far larger than a Mimic library, so it was not imported.' };

  const warnings: string[] = [];
  const byId = new Map<string, ClipRecord>();
  const unreadable: string[] = [];
  const newer: string[] = [];
  let duplicates = 0;
  for (const item of rawClips) {
    const r = inspectClipRecord(item);
    if (!r.ok) {
      (r.reason === 'newer' ? newer : unreadable).push(r.title ?? 'a clip without a title');
      continue;
    }
    const prior = byId.get(r.clip.id);
    if (prior) {
      duplicates++;
      if (time(r.clip.updatedAt) <= time(prior.updatedAt)) continue;
    }
    byId.set(r.clip.id, r.clip);
  }
  const names = (list: string[]): string => list.slice(0, 3).map((t) => `"${t}"`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
  if (unreadable.length) warnings.push(`${plural(unreadable.length, 'clip')} could not be read and ${unreadable.length === 1 ? 'was' : 'were'} skipped: ${names(unreadable)}.`);
  if (newer.length) warnings.push(`${plural(newer.length, 'clip')} ${newer.length === 1 ? 'was' : 'were'} saved by a newer version of Mimic and skipped: ${names(newer)}. Update the app to import ${newer.length === 1 ? 'it' : 'them'}.`);
  if (duplicates) warnings.push(`${plural(duplicates, 'clip')} appeared more than once in the file; the most recently edited copy was kept.`);

  const attempts: AttemptRecord[] = [];
  const seenAttempts = new Set<string>();
  let badAttempts = 0;
  let orphans = 0;
  for (const item of rawAttempts) {
    const a = parseAttemptRecord(item, { dropAudio: true });
    if (!a) {
      badAttempts++;
      continue;
    }
    if (seenAttempts.has(a.id)) continue;
    seenAttempts.add(a.id);
    if (!byId.has(a.clipId)) {
      orphans++;
      continue;
    }
    attempts.push(a);
  }
  if (badAttempts) warnings.push(`${plural(badAttempts, 'practice attempt')} could not be read and ${badAttempts === 1 ? 'was' : 'were'} skipped.`);
  if (orphans) warnings.push(`${plural(orphans, 'practice attempt')} belonged to clips that are not in the file and ${orphans === 1 ? 'was' : 'were'} skipped.`);

  const exportedAt = iso(json.exportedAt) ?? new Date(0).toISOString();
  return {
    ok: true,
    value: { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, exportedAt, clips: [...byId.values()], attempts, calibration: cleanCalibration(json.calibration) },
    warnings,
  };
}

/** Parses the text of a backup file; a file that is not JSON is reported in plain words. */
export function parseLibraryText(raw: string): LibraryParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'That file is not a Mimic library backup (it is not readable JSON). Choose a file made with "Export my library".' };
  }
  return parseLibraryExport(json);
}

export interface MergeResult {
  clips: ClipRecord[];
  added: number;
  updated: number;
  kept: number;
}

/**
 * Same `id`: the newest `updatedAt` wins (a tie keeps what is on the device). Clips that are new here arrive with
 * `audioMissing: true` until their file is added again. A clip that is updated keeps the audio it already has.
 */
export function mergeLibrary(existing: ClipRecord[], incoming: ClipRecord[]): MergeResult {
  const byId = new Map(existing.map((c) => [c.id, c]));
  let added = 0;
  let updated = 0;
  let kept = 0;
  for (const inc of incoming) {
    const cur = byId.get(inc.id);
    if (!cur) {
      byId.set(inc.id, { ...inc, audioMissing: true });
      added++;
    } else if (time(inc.updatedAt) > time(cur.updatedAt)) {
      byId.set(inc.id, { ...inc, audio: cur.audio, audioMissing: cur.audioMissing, fingerprint: cur.fingerprint || inc.fingerprint, durationSec: cur.audioMissing ? inc.durationSec : cur.durationSec });
      updated++;
    } else {
      kept++;
    }
  }
  const clips = [...byId.values()].sort((a, b) => time(b.addedAt) - time(a.addedAt) || (a.id < b.id ? 1 : -1));
  return { clips, added, updated, kept };
}

/**
 * The imported attempts worth keeping: new ids only, and only for phrases that still exist in the merged clip (an attempt
 * for a phrase the user has since merged or removed would be an orphan).
 */
export function selectNewAttempts(clips: ClipRecord[], knownAttemptIds: ReadonlySet<string>, incoming: AttemptRecord[]): { attempts: AttemptRecord[]; skippedOrphans: number } {
  const phrasesOf = new Map(clips.map((c) => [c.id, new Set(c.phrases.map((p) => p.id))]));
  const attempts: AttemptRecord[] = [];
  let skippedOrphans = 0;
  for (const a of incoming) {
    if (knownAttemptIds.has(a.id)) continue;
    if (!phrasesOf.get(a.clipId)?.has(a.phraseId)) {
      skippedOrphans++;
      continue;
    }
    attempts.push({ ...a, hasAudio: false });
  }
  return { attempts, skippedOrphans };
}

// ---------------------------------------------------------------------------------------------
// Relinking a re-imported file to a clip whose audio is missing

export interface FileProbe {
  fingerprint: string;
  fileName?: string;
  /** Duration of the whole file, seconds. */
  durationSec?: number;
}

/** File name and duration are close enough to call it the same file when the fingerprint is not available. */
const SAME_DURATION_SEC = 0.3;

const stripExt = (n: string): string => n.replace(/\.[a-z0-9]{1,5}$/i, '').trim().toLowerCase();

/**
 * Clips that this file probably is, best match first: the same fingerprint (size and content hash; the decoded length may differ by
 * 0.3 s), then the same file name with a duration within 0.3 s of the SOURCE file's length (read from the fingerprint: a clip's own
 * duration is only the excerpt that was kept). Only clips whose audio is missing are offered unless `includeWithAudio` is set (a duplicate-import warning).
 */
export function findRelinkCandidates(clips: ClipRecord[], probe: FileProbe, opts: { includeWithAudio?: boolean } = {}): ClipRecord[] {
  const exact: ClipRecord[] = [];
  const byName: ClipRecord[] = [];
  const probeName = probe.fileName ? stripExt(probe.fileName) : '';
  for (const c of clips) {
    if (!opts.includeWithAudio && !c.audioMissing) continue;
    if (probe.fingerprint && c.fingerprint && sameSourceFile(c.fingerprint, probe.fingerprint)) {
      exact.push(c);
      continue;
    }
    if (!probeName || probe.durationSec === undefined || !c.sourceFileName || stripExt(c.sourceFileName) !== probeName) continue;
    const fp = parseFingerprint(c.fingerprint);
    const clipSec = fp ? fp.durationMs / 1000 : c.durationSec;
    if (Math.abs(clipSec - probe.durationSec) <= SAME_DURATION_SEC) byName.push(c);
  }
  return [...exact, ...byName];
}

// ---------------------------------------------------------------------------------------------
// A clip's contribution to a singer's measured targets

/** Why this clip cannot be used for a singer's targets, in words that name the next step; null when it can. */
export function contributionBlocker(clip: ClipRecord): string | null {
  if (!clip.singerId) return 'Choose which singer this clip is of first.';
  if (clip.kind === 'mix') return 'A full song mix cannot set a singer\'s targets because the instruments change the tone measures. Add a vocal-only version of the clip to use it.';
  if (!clip.analysis.usableAsTarget) return clip.analysis.unusableReason ?? 'This clip has too little clear singing to measure.';
  return null;
}

/** The numbers coach/measured.ts clipFromAnalysis would produce for this clip, from its stored analysis summary; same id as the clip. */
export function measuredFromClip(clip: ClipRecord): MeasuredClip {
  const a = clip.analysis;
  return {
    id: clip.id,
    name: clip.title,
    addedAt: clip.addedAt,
    durationSec: a.durationSec,
    voicedSec: a.voicedSec,
    style: { ...a.style },
    pitch: { lowMidi: a.pitch.lowMidi, highMidi: a.pitch.highMidi, tessituraLowMidi: a.pitch.tessituraLowMidi, tessituraHighMidi: a.pitch.tessituraHighMidi },
  };
}

// ---------------------------------------------------------------------------------------------
// Attempts update their phrase

export function attemptLite(a: AttemptRecord): AttemptLite {
  return { at: a.at, overall: a.scores.overall, pitch: a.scores.pitch, timing: a.scores.timing, tone: a.scores.tone, expression: a.scores.expression, rate: a.rate, coverage: a.coverage, wrongNotes: a.wrongNotes, trust: a.trust };
}

const FULL_COVERAGE = 0.9;
const isFullSpeed = (a: AttemptRecord): boolean => a.rate >= MIN_MASTER_RATE && a.coverage >= FULL_COVERAGE;

/** A shift worth passing to the next comparison as `transposeHint`: the take was trusted and matched most of the phrase. */
export function isGoodKeyEvidence(a: AttemptRecord): boolean {
  return a.trust !== 'invalid' && a.coverage >= 0.5 && a.scores.pitch >= 40;
}

const byTime = (a: AttemptRecord, b: AttemptRecord): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function statsFrom(attempts: AttemptRecord[]): PhraseStats {
  if (attempts.length === 0) return { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null };
  const last = attempts[attempts.length - 1];
  return {
    attempts: attempts.length,
    fullSpeedAttempts: attempts.filter(isFullSpeed).length,
    best: Math.max(...attempts.map((a) => a.scores.overall)),
    last: last.scores.overall,
    recent: attempts.slice(-5).map((a) => a.scores.overall),
    lastAt: last.at,
  };
}

/**
 * Replays a phrase's whole history (any order) into fresh stats, review state and key hint (all blank when there is none).
 * Used after an import merged attempts from another copy of the library and after attempts were deleted; the attempts are
 * the truth, the phrase fields are a cache of them.
 */
export function rebuildPhraseState(phrase: PhraseRecord, attempts: AttemptRecord[]): PhraseRecord {
  const ordered = [...attempts].sort(byTime);
  let srs: PhraseSrsState = { rung: 0, dueAt: null, masteredAt: null };
  const lite: AttemptLite[] = [];
  let keyHint: number | null = null;
  for (const a of ordered) {
    lite.push(attemptLite(a));
    srs = afterAttempt(srs, lite, a.at);
    if (isGoodKeyEvidence(a)) keyHint = a.transposeSemitones;
  }
  return { ...phrase, stats: statsFrom(ordered), srs, keyHint };
}

/**
 * The phrase after one more attempt. `history` is the phrase's earlier attempts (any order, not including `attempt`; the
 * newest ~20 are enough). An attempt that cannot be trusted (speaker bleed) changes nothing.
 */
export function applyAttempt(phrase: PhraseRecord, history: AttemptRecord[], attempt: AttemptRecord): PhraseRecord {
  if (attempt.trust === 'invalid') return phrase;
  const all = [...history.filter((h) => h.id !== attempt.id), attempt].sort(byTime);
  const lite = all.map(attemptLite);
  const newest = all[all.length - 1];
  const prev = phrase.stats;
  const isNewest = newest.id === attempt.id;
  return {
    ...phrase,
    srs: isNewest ? afterAttempt(phrase.srs, lite, attempt.at) : phrase.srs,
    keyHint: isNewest && isGoodKeyEvidence(attempt) ? attempt.transposeSemitones : phrase.keyHint,
    stats: {
      attempts: prev.attempts + 1,
      fullSpeedAttempts: prev.fullSpeedAttempts + (isFullSpeed(attempt) ? 1 : 0),
      best: prev.best === null ? attempt.scores.overall : Math.max(prev.best, attempt.scores.overall),
      last: isNewest ? attempt.scores.overall : prev.last,
      recent: isNewest ? [...prev.recent, attempt.scores.overall].slice(-5) : prev.recent,
      lastAt: isNewest ? attempt.at : prev.lastAt,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Backup reminder

export interface ExportReminder {
  due: boolean;
  /** Names the next step; null when nothing is due. */
  message: string | null;
}

/**
 * A banner, not a modal: ask for a backup after REMIND_AFTER_ATTEMPTS new attempts, or after a week of unsaved practice.
 * `lastExportAt` null means never; the week then counts from the oldest clip.
 */
export function exportReminder(state: { clipCount: number; attemptsSinceExport: number; lastExportAt: string | null; oldestClipAt: string | null }, now: number): ExportReminder {
  const none: ExportReminder = { due: false, message: null };
  if (state.clipCount === 0 || state.attemptsSinceExport < 1) return none;
  const since = state.lastExportAt ? time(state.lastExportAt) : state.oldestClipAt ? time(state.oldestClipAt) : now;
  const n = state.attemptsSinceExport;
  if (n >= REMIND_AFTER_ATTEMPTS) {
    return { due: true, message: `${plural(n, 'practice attempt')} since your last backup. Export your library to keep your history safe.` };
  }
  if (now - since >= WEEK_MS) {
    return { due: true, message: `It has been over a week since your last backup. Export your library to keep your ${plural(n, 'new practice attempt')}.` };
  }
  return none;
}
