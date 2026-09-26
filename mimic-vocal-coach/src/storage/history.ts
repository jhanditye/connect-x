// Saved sessions (scores and measurements only, never audio) in localStorage under
// "mimic:v1:sessions", newest first, capped at MAX_SESSIONS. When storage is missing, blocked or
// full, the list lives in memory for the rest of the page session so saving still works.

import type { Comparison, SessionRecord, SingerProfile, StyleKey, StyleVector, VoiceAnalysis } from '../types';
import { isRecord, readJson, removeKey, writeJson } from './local';

export const SESSIONS_KEY = 'mimic:v1:sessions';
export const MAX_SESSIONS = 200;

// Exhaustive by construction: adding a StyleKey to types.ts without listing it here fails to compile.
const STYLE_KEY_SET: Record<StyleKey, true> = {
  breathiness: true,
  brightness: true,
  rasp: true,
  vibratoPresence: true,
  vibratoRateHz: true,
  vibratoExtentCents: true,
  chestInUpperRange: true,
  mixInUpperRange: true,
  headInUpperRange: true,
  loudnessClimbDbPerSemitone: true,
  agility: true,
  dynamicRangeDb: true,
  softOnsetRatio: true,
  pitchAccuracyCents: true,
  flipsPerMinute: true,
};
export const STYLE_KEYS = Object.keys(STYLE_KEY_SET) as StyleKey[];

/** Non-null once storage has proved unusable; from then on this copy is the source of truth. */
let memory: SessionRecord[] | null = null;

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function sanitizeStyle(x: unknown): StyleVector {
  const src = isRecord(x) ? x : {};
  const out = {} as StyleVector;
  for (const k of STYLE_KEYS) {
    const v = src[k];
    out[k] = finite(v) ? v : null;
  }
  return out;
}

/** Every reference profile has the id 'reference'; this prefix plus the clip name keeps clips apart. */
export const REFERENCE_PROFILE_PREFIX = 'reference:';

/**
 * The profileId a session is stored under. Builtin singers keep their id. A reference profile is
 * keyed by its clip name, so takes scored against different clips get separate trend lines.
 */
export function sessionProfileId(profile: Pick<SingerProfile, 'id' | 'name' | 'source'>): string {
  if (profile.source !== 'reference' && profile.id !== 'reference') return profile.id;
  const name = profile.name.trim();
  return name ? `${REFERENCE_PROFILE_PREFIX}${name}` : profile.id;
}

/** True for sessions scored against a reference clip rather than a builtin singer. */
export function isReferenceProfileId(profileId: string): boolean {
  return profileId === 'reference' || profileId.startsWith(REFERENCE_PROFILE_PREFIX);
}

/** A clean SessionRecord built from parsed JSON, or null when required fields are missing or malformed. */
export function parseSessionRecord(x: unknown): SessionRecord | null {
  if (!isRecord(x)) return null;
  const { id, createdAt, profileId: storedProfileId, profileName, overall, durationSec, label } = x;
  if (typeof id !== 'string' || !id) return null;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
  if (typeof storedProfileId !== 'string' || !storedProfileId) return null;
  if (typeof profileName !== 'string') return null;
  // Sessions saved before clips were told apart all say 'reference'; split them by clip name.
  const profileId = storedProfileId === 'reference' ? sessionProfileId({ id: storedProfileId, name: profileName, source: 'reference' }) : storedProfileId;
  if (!finite(overall) || !finite(durationSec)) return null;
  const dimensionScores: Partial<Record<StyleKey, number>> = {};
  if (isRecord(x.dimensionScores)) {
    for (const k of STYLE_KEYS) {
      const v = x.dimensionScores[k];
      if (finite(v)) dimensionScores[k] = v;
    }
  }
  const rec: SessionRecord = {
    id,
    createdAt,
    profileId,
    profileName,
    overall,
    dimensionScores,
    style: sanitizeStyle(x.style),
    durationSec,
  };
  if (typeof label === 'string' && label.trim()) rec.label = label;
  return rec;
}

function newestFirst(list: SessionRecord[]): SessionRecord[] {
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Parses a stored list, dropping corrupt entries and duplicate ids (first occurrence wins). */
function parseList(value: unknown): SessionRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SessionRecord[] = [];
  for (const item of value) {
    const rec = parseSessionRecord(item);
    if (rec && !seen.has(rec.id)) {
      seen.add(rec.id);
      out.push(rec);
    }
  }
  return out;
}

/** All saved sessions, newest first. Never throws. */
export function loadSessions(): SessionRecord[] {
  if (memory) return memory.map((s) => ({ ...s }));
  const read = readJson(SESSIONS_KEY);
  if (!read.available) {
    memory = [];
    return [];
  }
  return newestFirst(parseList(read.value));
}

function persist(list: SessionRecord[]): void {
  const capped = newestFirst(list).slice(0, MAX_SESSIONS);
  if (memory) {
    memory = capped;
    return;
  }
  if (!writeJson(SESSIONS_KEY, capped)) memory = capped;
}

/** Adds (or replaces, by id) a session and keeps the newest MAX_SESSIONS. */
export function saveSession(rec: SessionRecord): void {
  const clean = parseSessionRecord(rec);
  if (!clean) return;
  persist([clean, ...loadSessions().filter((s) => s.id !== clean.id)]);
}

export function deleteSession(id: string): void {
  const list = loadSessions();
  const next = list.filter((s) => s.id !== id);
  if (next.length !== list.length) persist(next);
}

export function clearSessions(): void {
  if (memory) {
    memory = [];
    return;
  }
  if (!removeKey(SESSIONS_KEY)) memory = [];
}

function newId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    // randomUUID is missing on insecure origins in some browsers; fall through.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A SessionRecord for the current result; only dimensions measured in this take get a score. */
export function sessionFromResults(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile, label?: string): SessionRecord {
  const dimensionScores: Partial<Record<StyleKey, number>> = {};
  for (const d of comparison.dimensions) {
    if (d.value !== null && Number.isFinite(d.value) && Number.isFinite(d.score)) dimensionScores[d.key] = Math.round(d.score * 10) / 10;
  }
  const rec: SessionRecord = {
    id: newId(),
    createdAt: new Date().toISOString(),
    profileId: sessionProfileId(profile),
    profileName: profile.name,
    overall: Number.isFinite(comparison.overall) ? Math.round(comparison.overall * 10) / 10 : 0,
    dimensionScores,
    // NaN would turn into null in JSON anyway; normalise now so the in-memory copy matches.
    style: sanitizeStyle(analysis.style),
    durationSec: Number.isFinite(analysis.durationSec) ? analysis.durationSec : 0,
  };
  const trimmed = label?.trim();
  if (trimmed) rec.label = trimmed;
  return rec;
}
