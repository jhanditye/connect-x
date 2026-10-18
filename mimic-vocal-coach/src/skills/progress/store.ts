// The Skills store in localStorage under "mimic:v1:skills" (src/skills/SPEC.md section 5): sessions (oldest first,
// capped), moving stats, personal bests and preferences. Reads are validated field by field and never throw. When
// storage is missing, blocked or keeps failing, the store lives in memory for the rest of the page session (like
// storage/settings.ts), so practice still works.
//
// loadSkillsStore() returns the same object until the stored text changes, so it can feed useSyncExternalStore
// directly. Treat every store as immutable: the update functions here return new objects.

import { getStorage, isRecord, removeKey } from '../../storage/local';
import { MAX_SKILLS_SESSIONS, SKILLS_STORE_KEY, SKILLS_STORE_VERSION, type SkillsPrefs, type SkillsSession, type SkillsStore } from '../types';
import {
  DEFAULT_SKILLS_PREFS,
  emptySkillsBests,
  emptySkillsStats,
  parseSessionList,
  parseSkillsBests,
  parseSkillsPrefs,
  parseSkillsSession,
  parseSkillsStats,
  PREF_FIELDS,
} from './parse';
import { applySessionToBests, applySessionToStats, rebuildStats } from './stats';


/** When the full store will not fit (quota), the newest this many sessions are tried, in turn. Stats and bests are kept. */
const SHRINK_STEPS = [300, 150, 50];

export function emptySkillsStore(): SkillsStore {
  return {
    version: SKILLS_STORE_VERSION,
    sessions: [],
    stats: emptySkillsStats(),
    bests: emptySkillsBests(),
    prefs: parseSkillsPrefs(DEFAULT_SKILLS_PREFS),
  };
}

/**
 * A clean store from anything (parsed JSON, a backup's `skills` field, garbage). Bad sessions are dropped, the rest
 * sorted oldest first and capped. Stored stats and bests are kept when present (they may include sessions the cap has
 * since dropped); a store without stats gets them rebuilt from its sessions.
 */
export function parseSkillsStore(x: unknown): SkillsStore {
  if (!isRecord(x)) return emptySkillsStore();
  const sessions = parseSessionList(x.sessions);
  const rebuilt = isRecord(x.stats) && isRecord(x.bests) ? null : rebuildStats(sessions);
  return {
    version: SKILLS_STORE_VERSION,
    sessions,
    stats: rebuilt ? rebuilt.stats : parseSkillsStats(x.stats),
    bests: rebuilt ? rebuilt.bests : parseSkillsBests(x.bests),
    prefs: parseSkillsPrefs(x.prefs),
  };
}

/** True when the store holds nothing worth backing up (preferences alone do not count). */
export function isSkillsStoreEmpty(s: SkillsStore): boolean {
  const st = s.stats;
  return (
    s.sessions.length === 0 &&
    !s.bests.hissSec &&
    !s.bests.longToneSec &&
    !s.bests.pacedExhaleCounts &&
    [st.hear, st.sing, st.hearDegree, st.degrees, st.registers].every((m) => Object.keys(m).length === 0)
  );
}

// ---------------------------------------------------------------------------------------------
// Pure updates

/**
 * The store with one more finished session: validated (an unusable session leaves the store unchanged), inserted in
 * time order, capped at MAX_SKILLS_SESSIONS (oldest dropped), stats and bests updated. Recording the same id twice is
 * a no-op, so a screen that reports twice does not count twice.
 */
export function recordSkillsSession(store: SkillsStore, session: SkillsSession): SkillsStore {
  const clean = parseSkillsSession(session);
  if (!clean || store.sessions.some((s) => s.id === clean.id)) return store;
  const t = Date.parse(clean.at);
  let i = store.sessions.length;
  while (i > 0 && Date.parse(store.sessions[i - 1].at) > t) i--;
  const sessions = [...store.sessions.slice(0, i), clean, ...store.sessions.slice(i)];
  return {
    ...store,
    sessions: sessions.length > MAX_SKILLS_SESSIONS ? sessions.slice(sessions.length - MAX_SKILLS_SESSIONS) : sessions,
    stats: applySessionToStats(store.stats, clean),
    bests: applySessionToBests(store.bests, clean),
  };
}

/** The store with some preferences changed. Each field is validated on its own; a bad value keeps the previous one. */
export function updateSkillsPrefs(store: SkillsStore, patch: Partial<SkillsPrefs>): SkillsStore {
  const prefs: Record<string, unknown> = { ...store.prefs };
  let changed = false;
  for (const k of Object.keys(patch) as (keyof SkillsPrefs)[]) {
    const validate = PREF_FIELDS[k] as ((x: unknown) => unknown) | undefined;
    if (!validate) continue;
    const v = validate(patch[k]);
    if (v === undefined) continue;
    prefs[k] = v;
    changed = true;
  }
  return changed ? { ...store, prefs: prefs as unknown as SkillsPrefs } : store;
}

/** A unique session id (crypto.randomUUID when the browser has it). */
export function skillsId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    // fall through
  }
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Persistence

/** Non-null once storage has proved unusable; from then on this copy is the source of truth. */
let memory: SkillsStore | null = null;
/** The last store read or written, with the exact stored text it came from. */
let cache: { raw: string | null; store: SkillsStore } | null = null;
const listeners = new Set<() => void>();
let storageListening = false;

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

/** The current store. Returns the same object until the stored data changes (safe as a useSyncExternalStore snapshot). */
export function loadSkillsStore(): SkillsStore {
  if (memory) return memory;
  const s = getStorage();
  if (!s) {
    memory = emptySkillsStore();
    return memory;
  }
  let raw: string | null;
  try {
    raw = s.getItem(SKILLS_STORE_KEY);
  } catch {
    memory = emptySkillsStore();
    return memory;
  }
  if (cache && cache.raw === raw) return cache.store;
  let value: unknown = null;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = null;
    }
  }
  const store = parseSkillsStore(value);
  cache = { raw, store };
  return store;
}

function tryWrite(text: string): boolean {
  const s = getStorage();
  if (!s) return false;
  try {
    s.setItem(SKILLS_STORE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the store and tells subscribers. True when it reached localStorage. When the full store does not fit, the
 * newest 300, then 150, then 50 sessions are tried (stats and bests always kept); when nothing can be written the
 * store stays in memory for this page session and false is returned.
 */
export function saveSkillsStore(store: SkillsStore): boolean {
  let ok = false;
  if (memory) {
    memory = store;
  } else {
    let text = JSON.stringify(store);
    ok = tryWrite(text);
    for (const keep of SHRINK_STEPS) {
      if (ok || store.sessions.length <= keep) continue;
      text = JSON.stringify({ ...store, sessions: store.sessions.slice(store.sessions.length - keep) });
      ok = tryWrite(text);
    }
    if (ok) cache = { raw: text, store };
    else {
      memory = store;
      cache = null;
    }
  }
  notify();
  return ok;
}

/** Calls `fn` after every save or clear here, and when another tab changes the store. Returns the unsubscribe. */
export function subscribeSkillsStore(fn: () => void): () => void {
  listeners.add(fn);
  if (!storageListening) {
    try {
      const w = (globalThis as { window?: Window }).window;
      if (w && typeof w.addEventListener === 'function') {
        w.addEventListener('storage', (e: StorageEvent) => {
          if (e.key === null || e.key === SKILLS_STORE_KEY) notify();
        });
        storageListening = true;
      }
    } catch {
      // No window (tests, workers): saves in this tab still notify.
    }
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Removes every Skills session, stat, best and preference (also the in-memory copy) and tells subscribers. */
export function clearSkillsStore(): void {
  removeKey(SKILLS_STORE_KEY);
  cache = null;
  if (memory) memory = emptySkillsStore();
  notify();
}

/** Test hook: forget the in-memory fallback and the cache (a fresh page). */
export function resetSkillsStoreForTests(): void {
  memory = null;
  cache = null;
}
