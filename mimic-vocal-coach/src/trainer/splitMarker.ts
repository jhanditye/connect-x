// A split of a song into its vocal runs the phone hard for minutes. If iOS ends the page meanwhile (memory, or a locked screen), the page
// simply comes back as a fresh start with no trace of what happened. This leaves a small note in localStorage while a split is running
// and removes it when the split ends any way (done, failed, cancelled); a note found at the next start means the last one was cut off,
// and the Add clips screen says so once, with the advice that helps (a shorter part, screen on).
//
// Only per-viewer state: it never leaves the device, holds a file name and two numbers, and the page works without it (private mode).

const KEY = 'mimic.isolateInProgress.v1';

/** Different on every page load, so a note written by this page's own (still running or just finished) split is never taken for a cut-off one. */
const SESSION = Math.random().toString(36).slice(2) + Date.now().toString(36);

export interface InterruptedSplit {
  fileName: string;
  /** Seconds of the song that were being split. */
  seconds: number;
  /** ms since 1970 when it started. */
  startedAt: number;
}

interface Stored extends InterruptedSplit {
  session: string;
}

let seen: InterruptedSplit | null | undefined; // looked at once per page load

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A split is starting: leave the note. */
export function markSplitStarted(info: { fileName: string; seconds: number }, now: number = Date.now()): void {
  seen = null; // a new split replaces any earlier "it was cut off" message
  try {
    const entry: Stored = { fileName: info.fileName, seconds: Math.round(info.seconds), startedAt: now, session: SESSION };
    store()?.setItem(KEY, JSON.stringify(entry));
  } catch {
    // storage full or blocked: the split still runs, it just cannot be recognised as cut off later
  }
}

/** The split ended (finished, failed or cancelled): take the note away. */
export function markSplitEnded(): void {
  try {
    const s = store();
    if (!s) return;
    const raw = s.getItem(KEY);
    if (raw === null) return;
    const entry = JSON.parse(raw) as Partial<Stored> | null;
    if (entry?.session === SESSION) s.removeItem(KEY); // never remove another page's note
  } catch {
    // ignore
  }
}

/**
 * The split that an earlier page was running when it ended, or null. Looked up once per page load (the note is removed as it is read,
 * and the answer is kept so a screen that opens twice shows the same message); starting a new split clears it.
 */
export function interruptedSplit(): InterruptedSplit | null {
  if (seen !== undefined) return seen;
  seen = null;
  try {
    const s = store();
    const raw = s?.getItem(KEY);
    if (!s || raw == null) return null;
    s.removeItem(KEY);
    const e = JSON.parse(raw) as Partial<Stored> | null;
    if (!e || e.session === SESSION || typeof e.fileName !== 'string' || !(typeof e.seconds === 'number') || !(typeof e.startedAt === 'number')) return null;
    seen = { fileName: e.fileName, seconds: e.seconds, startedAt: e.startedAt };
  } catch {
    seen = null;
  }
  return seen;
}

/** Test seam: forget what this page has looked at. */
export function resetSplitMarkerForTests(): void {
  seen = undefined;
}
