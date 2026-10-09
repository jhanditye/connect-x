// Storage estimate, persistence request and the pre-import space check. Every browser call is optional: Safari before 17
// has no estimate(), a sandboxed frame may have no navigator.storage at all, and any of them can throw or hang.

import { audioBytes, MAX_STORE_RATE } from '../audio/pcm';

export interface StorageStatus {
  supported: boolean;
  /** Bytes used by this origin, null when the browser does not say (Safari before 17). */
  usage: number | null;
  quota: number | null;
  /** navigator.storage.persisted(); null when unsupported. */
  persisted: boolean | null;
}

export const UNKNOWN_STORAGE: StorageStatus = { supported: false, usage: null, quota: null, persisted: null };

/** A browser call that never answers must not hold up the library screen. */
const STORAGE_CALL_TIMEOUT_MS = 4000;

function storageManager(): StorageManager | null {
  try {
    const s = (globalThis as { navigator?: Navigator }).navigator?.storage;
    return s ?? null;
  } catch {
    return null;
  }
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const s = storageManager();
  if (!s) return { ...UNKNOWN_STORAGE };
  let usage: number | null = null;
  let quota: number | null = null;
  let persisted: boolean | null = null;
  try {
    if (typeof s.estimate === 'function') {
      const e = await withTimeout(Promise.resolve(s.estimate()), STORAGE_CALL_TIMEOUT_MS);
      usage = finiteOrNull(e?.usage);
      quota = finiteOrNull(e?.quota);
    }
  } catch {
    // Leave usage and quota unknown.
  }
  try {
    if (typeof s.persisted === 'function') {
      const p = await withTimeout(Promise.resolve(s.persisted()), STORAGE_CALL_TIMEOUT_MS);
      persisted = typeof p === 'boolean' ? p : null;
    }
  } catch {
    // Leave persisted unknown.
  }
  return { supported: typeof s.estimate === 'function' || typeof s.persist === 'function', usage, quota, persisted };
}

/** Asks the browser not to evict this origin's data (Safari 15.2+). Call it from a tap handler. Resolves false when refused or unsupported. */
export async function requestPersistence(): Promise<boolean> {
  const s = storageManager();
  if (!s || typeof s.persist !== 'function') return false;
  try {
    if (typeof s.persisted === 'function' && (await withTimeout(Promise.resolve(s.persisted()), STORAGE_CALL_TIMEOUT_MS))) return true;
    return (await withTimeout(Promise.resolve(s.persist()), STORAGE_CALL_TIMEOUT_MS)) === true;
  } catch {
    return false;
  }
}

/** "412 KB", "5.5 MB", "1.2 GB"; "unknown" for null. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${bytes < 1e7 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Bytes a clip of `frames` frames takes once stored; a second file holding an isolated vocal doubles it. */
export function estimateImportBytes(frames: number, opts: { stem?: boolean } = {}): number {
  return audioBytes(frames) * (opts.stem ? 2 : 1);
}

export interface SpaceCheck {
  /** 'unknown': the browser does not report free space, so go ahead and let a QuotaError speak if it comes. */
  level: 'ok' | 'tight' | 'insufficient' | 'unknown';
  needBytes: number;
  freeBytes: number | null;
  /** Names the next step; null when there is nothing to say. */
  message: string | null;
  /** Storing at 32 kHz (two thirds of the size) would fit when the full-rate clip does not. */
  suggestLowerRate: boolean;
}

/** Above this share of the space that is left, warn before importing. */
const TIGHT_SHARE = 0.8;
const LOWER_RATE = 32000;

/** Before-import check (needed bytes against quota minus usage). */
export function checkImportSpace(needBytes: number, status: StorageStatus): SpaceCheck {
  const need = Number.isFinite(needBytes) && needBytes > 0 ? needBytes : 0;
  const free = status.quota !== null && status.usage !== null ? Math.max(0, status.quota - status.usage) : null;
  if (need === 0) return { level: 'ok', needBytes: 0, freeBytes: free, message: null, suggestLowerRate: false };
  if (free === null) return { level: 'unknown', needBytes: need, freeBytes: null, message: null, suggestLowerRate: false };
  const lowerFits = need * (LOWER_RATE / MAX_STORE_RATE) <= free * TIGHT_SHARE;
  if (need > free) {
    return {
      level: 'insufficient',
      needBytes: need,
      freeBytes: free,
      message:
        `Not enough room on this device (this clip needs about ${formatBytes(need)}, ${formatBytes(free)} is free). ` +
        (lowerFits ? 'Trim the clip to the part you want, or remove clips you no longer practise.' : 'Remove clips you no longer practise, or trim this one to the part you want.'),
      suggestLowerRate: lowerFits,
    };
  }
  if (need > free * TIGHT_SHARE) {
    return {
      level: 'tight',
      needBytes: need,
      freeBytes: free,
      message: `This clip would use most of the space that is left (about ${formatBytes(need)} of ${formatBytes(free)}). Trim it to the part you want, or remove clips you no longer practise.`,
      suggestLowerRate: lowerFits,
    };
  }
  return { level: 'ok', needBytes: need, freeBytes: free, message: null, suggestLowerRate: false };
}

/** The note a Mac or desktop browser shows in place of the Home Screen sentence (worded in src/pwa/words.ts). */
export interface DesktopNoteWords {
  note: string;
}

/** True when the app runs from the Home Screen (iOS standalone or any display-mode: standalone / fullscreen). */
export function isInstalledPwa(): boolean {
  try {
    const nav = (globalThis as { navigator?: Navigator & { standalone?: boolean } }).navigator;
    if (nav?.standalone === true) return true;
    const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
    if (typeof mm === 'function') return mm.call(globalThis, '(display-mode: standalone)').matches || mm.call(globalThis, '(display-mode: fullscreen)').matches;
  } catch {
    // Treat an unreadable display mode as "not installed".
  }
  return false;
}

/**
 * One plain sentence about where the clips live, or null when nothing needs saying. Safari removes a website's data after a
 * week without use, but not an app saved to the Home Screen, so a browser tab is told to install.
 */
export function storageNote(status: StorageStatus, ctx: { memoryOnly: boolean; installed: boolean; /** The words for a Mac or another computer; omitted, the phone wording applies. */ desktop?: DesktopNoteWords }): string | null {
  if (ctx.memoryOnly) {
    return 'This browser would not let Mimic store clips, so they will be lost when you close the app. Export a backup of your library to keep your practice history.';
  }
  if (!ctx.installed && status.persisted !== true) {
    if (ctx.desktop) return ctx.desktop.note;
    return 'Add Mimic to your Home Screen to keep your clips. A browser tab can lose its saved data after a week without use.';
  }
  if (status.quota !== null && status.usage !== null && status.quota > 0 && status.usage / status.quota > 0.9) {
    return `This device is nearly full (${formatBytes(status.usage)} of ${formatBytes(status.quota)} used). Remove clips you no longer practise.`;
  }
  return null;
}
