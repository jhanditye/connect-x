// Guarded access to localStorage. Storage can be missing (server rendering), blocked (privacy
// settings, sandboxed iframes: even reading `window.localStorage` can throw) or full (quota). Every
// helper returns a failure value instead of throwing so callers can fall back to memory.

/** The Storage object, or null when it is missing or access is blocked. */
export function getStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

export type ReadResult =
  /** Storage is missing or blocked: the caller should use its in-memory copy. */
  | { available: false }
  /** `value` is null when the key is absent and undefined when the stored text is not valid JSON. */
  | { available: true; value: unknown };

export function readJson(key: string): ReadResult {
  const s = getStorage();
  if (!s) return { available: false };
  let raw: string | null;
  try {
    raw = s.getItem(key);
  } catch {
    return { available: false };
  }
  if (raw === null) return { available: true, value: null };
  try {
    return { available: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { available: true, value: undefined };
  }
}

/** Writes JSON; false when storage is unusable or the write fails (quota, blocked). */
export function writeJson(key: string, value: unknown): boolean {
  const s = getStorage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): boolean {
  const s = getStorage();
  if (!s) return false;
  try {
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every key this app keeps in localStorage (they all start with "mimic." or "mimic:"): settings, the API key, saved
 * sessions, measured targets, the microphone choice, trainer preferences and the small "already seen" flags. Returns how many were removed.
 */
export function removeAllAppKeys(): number {
  const s = getStorage();
  if (!s) return 0;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && /^mimic[.:]/.test(k)) doomed.push(k);
    }
  } catch {
    return 0;
  }
  let n = 0;
  for (const k of doomed) if (removeKey(k)) n++;
  return n;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
