// The trainer library's state and the pure functions around it. The provider (TrainerProvider.tsx) feeds this reducer
// from IndexedDB; everything here is synchronous and testable without a browser.

import { attemptLite } from '../storage/library';
import { UNKNOWN_STORAGE, type StorageStatus } from '../storage/quota';
import { practiceQueue, type AttemptLite, type QueueItem } from '../trainer/srs';
import type { AttemptRecord, ClipRecord, PhraseRecord } from '../types';
import type { TrainerController } from './trainerContext';

/** How many of a phrase's newest attempts the app keeps in memory (the review ladder and the stuck test read the last few). */
export const RECENT_PER_PHRASE = 20;
/** Attempt history kept per phrase on the device; older ones are dropped as new ones arrive (about 2 KB each). */
export const MAX_ATTEMPTS_PER_PHRASE = 250;
/** Rolling recordings kept per phrase when the singer asked to keep them. */
export const KEEP_RECORDINGS_PER_PHRASE = 3;
const MAX_TITLE = 120;
const MAX_LABEL = 60;
const MAX_NOTES = 2000;
const MAX_TAGS = 20;
const MAX_TAG = 40;
/** A phrase window shorter than this cannot hold a note. */
export const MIN_PHRASE_SEC = 0.3;

export interface TrainerState {
  status: TrainerController['status'];
  error: string | null;
  /** Why the library is memory-only (the browser's reason), or null. */
  memoryReason: string | null;
  clips: ClipRecord[];
  /** Newest attempts per phrase id, oldest first. */
  recent: Record<string, AttemptLite[]>;
  storage: StorageStatus;
  /** Things worth telling the singer about from loading (records that could not be read). */
  warnings: string[];
  lastExportAt: string | null;
  attemptsSinceExport: number;
  /** Clock for "review due"; refreshed when the app comes back to the foreground. */
  now: number;
}

export type TrainerAction =
  | { type: 'loaded'; clips: ClipRecord[]; recent: Record<string, AttemptLite[]>; memoryReason: string | null; warnings: string[]; lastExportAt: string | null; attemptsSinceExport: number }
  | { type: 'failed'; message: string }
  | { type: 'recovered' }
  | { type: 'clips/set'; clips: ClipRecord[] }
  | { type: 'clip/put'; clip: ClipRecord }
  | { type: 'clip/remove'; id: string }
  | { type: 'recent/set'; phraseId: string; attempts: AttemptLite[] }
  | { type: 'recent/replace'; recent: Record<string, AttemptLite[]> }
  | { type: 'storage'; storage: StorageStatus }
  | { type: 'export'; lastExportAt: string | null; attemptsSinceExport: number }
  | { type: 'tick'; now: number }
  | { type: 'reset' };

export function initialTrainerState(now: number = Date.now()): TrainerState {
  return {
    status: 'loading',
    error: null,
    memoryReason: null,
    clips: [],
    recent: {},
    storage: { ...UNKNOWN_STORAGE },
    warnings: [],
    lastExportAt: null,
    attemptsSinceExport: 0,
    now,
  };
}

const addedTime = (c: ClipRecord): number => {
  const t = Date.parse(c.addedAt);
  return Number.isFinite(t) ? t : 0;
};
const newestClipFirst = (a: ClipRecord, b: ClipRecord): number => addedTime(b) - addedTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Drops the cached attempts of phrases that no longer exist. */
function pruneRecent(recent: Record<string, AttemptLite[]>, clips: ClipRecord[]): Record<string, AttemptLite[]> {
  const keep = new Set(clips.flatMap((c) => c.phrases.map((p) => p.id)));
  const next: Record<string, AttemptLite[]> = {};
  for (const [id, list] of Object.entries(recent)) if (keep.has(id)) next[id] = list;
  return next;
}

export function trainerReducer(state: TrainerState, action: TrainerAction): TrainerState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        status: action.memoryReason ? 'memory-only' : 'ready',
        error: null,
        memoryReason: action.memoryReason,
        clips: [...action.clips].sort(newestClipFirst),
        recent: pruneRecent(action.recent, action.clips),
        warnings: action.warnings,
        lastExportAt: action.lastExportAt,
        attemptsSinceExport: action.attemptsSinceExport,
      };
    case 'failed':
      return { ...state, status: 'error', error: action.message };
    case 'recovered':
      return state.status === 'error' ? { ...state, status: state.memoryReason ? 'memory-only' : 'ready', error: null } : state;
    case 'clips/set':
      return { ...state, clips: [...action.clips].sort(newestClipFirst), recent: pruneRecent(state.recent, action.clips) };
    case 'clip/put': {
      const clips = [...state.clips.filter((c) => c.id !== action.clip.id), action.clip].sort(newestClipFirst);
      return { ...state, clips, recent: pruneRecent(state.recent, clips) };
    }
    case 'clip/remove': {
      const clips = state.clips.filter((c) => c.id !== action.id);
      return { ...state, clips, recent: pruneRecent(state.recent, clips) };
    }
    case 'recent/set':
      return { ...state, recent: { ...state.recent, [action.phraseId]: action.attempts.slice(-RECENT_PER_PHRASE) } };
    case 'recent/replace':
      return { ...state, recent: pruneRecent(action.recent, state.clips) };
    case 'storage':
      return { ...state, storage: action.storage };
    case 'export':
      return { ...state, lastExportAt: action.lastExportAt, attemptsSinceExport: action.attemptsSinceExport };
    case 'tick':
      return action.now === state.now ? state : { ...state, now: action.now };
    case 'reset':
      return { ...state, clips: [], recent: {}, warnings: [], lastExportAt: null, attemptsSinceExport: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Selectors

/** Groups attempts by phrase, oldest first, keeping the newest `perPhrase` of each. */
export function recentFromAttempts(attempts: AttemptRecord[], perPhrase: number = RECENT_PER_PHRASE): Record<string, AttemptLite[]> {
  const byPhrase = new Map<string, AttemptRecord[]>();
  for (const a of attempts) byPhrase.set(a.phraseId, [...(byPhrase.get(a.phraseId) ?? []), a]);
  const out: Record<string, AttemptLite[]> = {};
  for (const [id, list] of byPhrase) out[id] = list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(-perPhrase).map(attemptLite);
  return out;
}

/** Today's practice list across all clips whose audio is on the device: due reviews, stuck phrases, phrases being learned, then new ones. */
export function selectQueue(state: Pick<TrainerState, 'clips' | 'recent' | 'now'>, limit = 5): QueueItem[] {
  const phrases = state.clips
    .filter((c) => !c.audioMissing)
    .flatMap((c) => c.phrases.filter((p) => !p.hidden).map((p) => ({ id: p.id, srs: p.srs, attempts: state.recent[p.id] ?? [] })));
  return practiceQueue(phrases, state.now, limit);
}

/** The clip and phrase for a phrase id (queue items carry only the phrase id; ids are unique across the library). */
export function findPhrase(clips: ClipRecord[], phraseId: string): { clip: ClipRecord; phrase: PhraseRecord } | null {
  for (const clip of clips) {
    const phrase = clip.phrases.find((p) => p.id === phraseId);
    if (phrase) return { clip, phrase };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Edits

export type ClipPatch = Parameters<TrainerController['updateClip']>[1];

export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const t of tags) if (typeof t === 'string' && t.trim()) out.add(t.trim().slice(0, MAX_TAG));
  return [...out].slice(0, MAX_TAGS);
}

/**
 * The clip with an edit applied and `updatedAt` set. Throws an Error whose message names the fix. `singerIds` is the list of
 * singers the app knows; null skips that check.
 */
export function applyClipPatch(clip: ClipRecord, patch: ClipPatch, nowIso: string, singerIds: ReadonlySet<string> | null = null): ClipRecord {
  const next: ClipRecord = { ...clip };
  if (patch.title !== undefined) {
    const title = String(patch.title).trim().slice(0, MAX_TITLE);
    if (!title) throw new Error('Give the clip a name.');
    next.title = title;
  }
  if (patch.singerId !== undefined) {
    if (patch.singerId !== null && (typeof patch.singerId !== 'string' || !patch.singerId || (singerIds && !singerIds.has(patch.singerId)))) {
      throw new Error('Choose one of the singers in the list, or "Someone else".');
    }
    next.singerId = patch.singerId;
    // A named singer replaces any free-text name; "someone else" keeps the label the singer typed.
    if (patch.singerId !== null && patch.singerLabel === undefined) next.singerLabel = '';
  }
  if (patch.singerLabel !== undefined) next.singerLabel = String(patch.singerLabel).trim().slice(0, MAX_LABEL);
  if (patch.notes !== undefined) next.notes = String(patch.notes).slice(0, MAX_NOTES);
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.difficulty !== undefined) {
    if (patch.difficulty !== null && patch.difficulty !== 1 && patch.difficulty !== 2 && patch.difficulty !== 3) throw new Error('Difficulty is 1, 2 or 3.');
    next.difficulty = patch.difficulty;
  }
  next.updatedAt = nowIso;
  return next;
}

/**
 * A phrase list from the editor made safe to store: windows clamped to the clip, too-short and repeated ones dropped,
 * sorted by start and renumbered. Throws when it is not a list.
 */
export function normalizePhrases(phrases: PhraseRecord[], durationSec: number): PhraseRecord[] {
  if (!Array.isArray(phrases)) throw new Error('The phrase list is not valid.');
  const limit = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const seen = new Set<string>();
  const out: PhraseRecord[] = [];
  for (const p of phrases) {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id) || !Number.isFinite(p.start) || !Number.isFinite(p.end)) continue;
    const end = Math.min(p.end, limit);
    const start = Math.max(0, Math.min(p.start, end));
    if (end - start < MIN_PHRASE_SEC) continue;
    seen.add(p.id);
    const clamp = (x: number, fallback: number) => (Number.isFinite(x) ? Math.min(end, Math.max(start, x)) : fallback);
    out.push({ ...p, start, end, voicedStart: clamp(p.voicedStart, start), voicedEnd: clamp(p.voicedEnd, end), rate: Number.isFinite(p.rate) ? Math.min(1, Math.max(0.5, p.rate)) : 1 });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out.map((p, index) => ({ ...p, index }));
}
