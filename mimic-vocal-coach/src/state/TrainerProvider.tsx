// Owns the clip library's async state (IndexedDB), nested inside AppProvider. The data-facing half of TrainerController is
// real here: library load, storage status, the practice queue, attempts, add / remove / rename / assign a singer, the
// contribution to a singer's measured targets, export / import, clear all.
//
// Two seams are left for the integrator, both typed below:
//   - `openPractice`  (prop)  builds the PracticeEngine for one phrase from a PracticeSession (the audio and compare modules)
//   - `importer`      (prop)  defaults to trainer/import.ts (prepareClip, commitClip, relinkAudio)
// and AppController.clearAllData should call the hook registered through `onClear` (see the effect near the end).
//
// Rules this file keeps: every change reads the clip fresh from the store before it writes (so a stale screen cannot
// overwrite newer data), changes to one clip run one after another, a clip is either fully stored or absent, and a store
// that stops answering turns into an `error` status with the next step instead of a hang. A library that fails to open (a timeout,
// one of Safari's random errors) does not stay memory-only for good: it is opened again on `reload()`, before a clip is saved and
// when the app returns to the foreground, and the clips added in the meantime are copied into it. A backup file that could not
// include everything is reported (`lastExportReport`) and does not clear the backup reminder.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import {
  copyLibrary,
  createMemoryClipStore,
  META,
  OPEN_TIMEOUT_MESSAGE,
  openClipStoreWithFallback,
  QuotaError,
  StoreUnavailableError,
  type ClipStore,
  type OpenedStore,
} from '../storage/clips';
import {
  applyAttempt,
  buildLibraryExport,
  contributionBlocker,
  exportReminder as computeExportReminder,
  inspectClipRecord,
  MAX_IMPORT_BYTES,
  measuredFromClip,
  mergeLibrary,
  parseLibraryText,
  rebuildPhraseState,
  selectNewAttempts,
  type ExportReminder,
} from '../storage/library';
import { checkImportSpace, estimateImportBytes, getStorageStatus, isInstalledPwa, requestPersistence as askForPersistence, storageNote, type StorageStatus } from '../storage/quota';
import { DEFAULT_SETTINGS } from '../storage/settings';
import * as importModule from '../trainer/import';
import { clearPhraseAnalysisCache } from '../trainer/phraseAnalysis';
import type { CommitEdits, ImportProgress, PreparedClip } from '../trainer/import';
import type { PracticeEngine } from '../trainer/engine';
import { MAX_STORE_RATE } from '../audio/pcm';
import type { AppSettings, AttemptRecord, ClipRecord, PhraseRecord } from '../types';
import { AppContext, type AppController } from './context';
import { TrainerContext, type ExportReport, type TrainerController } from './trainerContext';
import {
  applyClipPatch,
  findPhrase,
  initialTrainerState,
  KEEP_RECORDINGS_PER_PHRASE,
  MAX_ATTEMPTS_PER_PHRASE,
  normalizePhrases,
  recentFromAttempts,
  RECENT_PER_PHRASE,
  selectQueue,
  trainerReducer,
  type TrainerAction,
} from './trainerReducer';

export { useTrainer, type TrainerController } from './trainerContext';

// ---------------------------------------------------------------------------------------------
// The seams

/** What the audio / compare modules receive for one open phrase. */
export interface PracticeSession {
  clip: ClipRecord;
  phrase: PhraseRecord;
  store: ClipStore;
  settings: AppSettings;
  /**
   * Saves a scored attempt: stores it (with the recording when one is given), updates the phrase's stats, review ladder and
   * key hint, refreshes the practice queue. An attempt whose trust is 'invalid' (speaker bleed) is not saved. When the device
   * has no room for the recording the score is still saved and `notice` says so.
   */
  recordAttempt(attempt: AttemptRecord, recording?: { pcm: Int16Array; sampleRate: number }): Promise<{ saved: boolean; phrase: PhraseRecord; notice: string | null }>;
  /** Median sync offset (ms) per input route kind, learned across sessions. */
  getCalibration(): Promise<Record<string, number>>;
  setCalibration(route: string, offsetMs: number): Promise<void>;
}

/** Builds the engine for one phrase. The integrator wires the real one (audio/duplex, audio/player, trainer/compare). */
export type OpenPracticeFn = (session: PracticeSession) => Promise<PracticeEngine>;

export interface TrainerImporter {
  prepareClip: typeof importModule.prepareClip;
  commitClip: typeof importModule.commitClip;
  relinkAudio: typeof importModule.relinkAudio;
}

/** Extra, optional data for screens that want it (Settings, the backup banner). Safe to read without a provider. */
export interface TrainerExtras {
  /** The browser's reason when the library is memory-only. */
  memoryReason: string | null;
  /** Memory-only because opening the library failed in a way that opening it again can fix: `reload()` (a "Try again" button) tries. */
  canRetryOpen?: boolean;
  /** Records that could not be read when the library loaded, in plain words. */
  warnings: string[];
  exportReminder: ExportReminder;
  /** One plain sentence about where the clips live (install to the Home Screen, memory-only, nearly full), or null. */
  storageNote: string | null;
  /**
   * Reads the library again. While the library is memory-only after a failed open (a timeout, one of Safari's random errors), it first
   * tries to open IndexedDB again and, when that works, copies the clips added in this session into it.
   */
  reload(): Promise<void>;
  refreshStorage(): Promise<StorageStatus>;
  /** Asks the browser to keep this site's data. Call it from a tap. */
  requestPersistence(): Promise<boolean>;
}

const INERT_EXTRAS: TrainerExtras = {
  memoryReason: null,
  canRetryOpen: false,
  warnings: [],
  exportReminder: { due: false, message: null },
  storageNote: null,
  reload: () => Promise.resolve(),
  refreshStorage: () => Promise.resolve({ supported: false, usage: null, quota: null, persisted: null }),
  requestPersistence: () => Promise.resolve(false),
};

export const TrainerExtrasContext = createContext<TrainerExtras | null>(null);

export function useTrainerExtras(): TrainerExtras {
  return useContext(TrainerExtrasContext) ?? INERT_EXTRAS;
}

const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented'));

/** A controller that holds no data and does nothing (status 'loading'). For tests that only need the shape. */
export function createInertTrainerController(): TrainerController {
  return {
    status: 'loading',
    error: null,
    clips: [],
    storage: { supported: false, usage: null, quota: null, persisted: null },
    singers: [],
    queue: [],
    getClip: () => undefined,
    updateClip: notImplemented,
    updatePhrases: notImplemented,
    deleteClip: notImplemented,
    setContributes: notImplemented,
    exportLibrary: notImplemented,
    importLibrary: notImplemented,
    prepareClip: notImplemented,
    commitClip: notImplemented,
    relinkClip: notImplemented,
    listAttempts: () => Promise.resolve([]),
    deleteAttempts: () => Promise.resolve(0),
    openPractice: notImplemented,
    clearAll: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const CLIP_GONE = 'That clip is no longer in the library.';
const LIBRARY_CLOSED = 'The library is not open. Reload the app and try again.';
/** Channel the tabs of this origin use to tell each other the library changed. */
const CHANNEL = 'mimic-trainer-library';
/** How many of a phrase's newest attempts the review ladder is given when a new one arrives. */
const HISTORY_FOR_REVIEW = RECENT_PER_PHRASE;

/** Runs tasks that share a key one after another, so two changes to one clip cannot overwrite each other. */
export function createKeyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/** Wraps a store so the ids it writes are known, to undo a failed import. */
function trackWrites(store: ClipStore): { store: ClipStore; touched: Set<string> } {
  const touched = new Set<string>();
  return {
    touched,
    store: {
      ...store,
      putClip: (clip) => (touched.add(clip.id), store.putClip(clip)),
      writeAudio: (clipId, kind, pcm, sampleRate) => (touched.add(clipId), store.writeAudio(clipId, kind, pcm, sampleRate)),
    },
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface Loaded {
  clips: ClipRecord[];
  recent: ReturnType<typeof recentFromAttempts>;
  warnings: string[];
  lastExportAt: string | null;
  attemptsSinceExport: number;
}

async function loadLibrary(store: ClipStore): Promise<Loaded> {
  const raw = await store.listClips();
  const clips: ClipRecord[] = [];
  let unreadable = 0;
  let newer = 0;
  for (const r of raw) {
    const i = inspectClipRecord(r);
    if (i.ok) clips.push(i.clip);
    else if (i.reason === 'newer') newer++;
    else unreadable++;
  }
  const warnings: string[] = [];
  if (unreadable) warnings.push(`${unreadable} saved ${unreadable === 1 ? 'clip' : 'clips'} could not be read and ${unreadable === 1 ? 'is' : 'are'} hidden. ${unreadable === 1 ? 'It stays' : 'They stay'} on this device untouched.`);
  if (newer) warnings.push(`${newer} saved ${newer === 1 ? 'clip was' : 'clips were'} written by a newer version of Mimic and ${newer === 1 ? 'is' : 'are'} hidden. Update the app to see ${newer === 1 ? 'it' : 'them'}.`);
  const recent = recentFromAttempts(await store.listRecentAttempts(RECENT_PER_PHRASE));
  const lastExportAt = await store.getMeta<string>(META.lastExportAt);
  const since = await store.getMeta<number>(META.attemptsSinceExport);
  return { clips, recent, warnings, lastExportAt: typeof lastExportAt === 'string' ? lastExportAt : null, attemptsSinceExport: typeof since === 'number' && since > 0 ? Math.floor(since) : 0 };
}

export interface TrainerProviderProps {
  children: ReactNode;
  /** An already open store (tests inject createMemoryClipStore()); the provider does not close it. Without one the provider opens IndexedDB and falls back to memory. */
  store?: ClipStore;
  /** How to open the store when none is injected (default: openClipStore with the memory fallback). Read once. */
  openStore?: () => Promise<ClipStore>;
  /** The practice engine factory (see PracticeSession). Without one, openPractice rejects with a message. */
  openPractice?: OpenPracticeFn;
  importer?: Partial<TrainerImporter>;
  /** Clock, for tests. */
  now?: () => number;
  /** Tell other tabs when the library changes, and reload when they do. Default: only for an IndexedDB store. */
  syncTabs?: boolean;
  /** How long the library may take to open before the session goes memory-only with a "try again" (default 15 s; clips.ts has its own, shorter bound). */
  openWatchdogMs?: number;
}

const OPEN_WATCHDOG_MS = 15_000;
/** The app coming back to the foreground retries a failed open at most this often. */
const RETRY_OPEN_EVERY_MS = 20_000;

export function TrainerProvider(props: TrainerProviderProps) {
  const { children, store: injected } = props;
  const app = useContext(AppContext);
  const nowFn = props.now ?? Date.now;
  const [state, dispatch] = useReducer(trainerReducer, undefined, () => initialTrainerState(nowFn()));

  // Everything the actions need is read from refs, so the actions keep one identity for the life of the provider.
  const stateRef = useRef(state);
  stateRef.current = state;
  const appRef = useRef<AppController | null>(app);
  appRef.current = app;
  const propsRef = useRef(props);
  propsRef.current = props;
  const storeRef = useRef<ClipStore | null>(null);
  const loadedRef = useRef<Promise<void>>(Promise.resolve());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const persistAskedRef = useRef(false);
  const clearing = useRef<Promise<void> | null>(null);
  const pendingExport = useRef<{ at: string; attemptsAtBuild: number } | null>(null);
  const lastExport = useRef<ExportReport | null>(null);
  /** Opens IndexedDB again after a failed open and moves this session's clips into it; set by the effect that owns the store. */
  const recoverRef = useRef<(() => Promise<boolean>) | null>(null);
  const retryRef = useRef(false);
  /** Why the library is memory-only right now; read synchronously by the actions that reload (the state lags a render behind). */
  const memoryRef = useRef<{ reason: string | null; retryable: boolean }>({ reason: null, retryable: false });
  const queue = useMemo(createKeyedQueue, []);

  const send = useCallback((action: TrainerAction) => dispatch(action), []);

  const refreshStorage = useCallback(async (): Promise<StorageStatus> => {
    const status = await getStorageStatus();
    let usage = status.usage;
    if (usage === null) {
      // Safari before 17 cannot say; the audio we hold is most of it.
      try {
        usage = (await storeRef.current?.usage())?.audioBytes ?? null;
      } catch {
        usage = null;
      }
    }
    const next = { ...status, usage };
    send({ type: 'storage', storage: next });
    return next;
  }, [send]);

  const actions = useMemo(() => {
    const iso = (): string => new Date((propsRef.current.now ?? Date.now)()).toISOString();
    const settings = (): AppSettings => appRef.current?.state.settings ?? DEFAULT_SETTINGS;

    const getStore = async (): Promise<ClipStore> => {
      await loadedRef.current;
      const s = storeRef.current;
      if (!s) throw new Error(LIBRARY_CLOSED);
      return s;
    };

    /** A store that stops answering becomes an error state with the next step, and the caller still sees the failure. */
    const guard = async <T,>(task: () => Promise<T>): Promise<T> => {
      try {
        return await task();
      } catch (err) {
        if (err instanceof StoreUnavailableError && !/closed/i.test(err.message)) send({ type: 'failed', message: err.message });
        throw err;
      }
    };

    const notifyTabs = (): void => {
      try {
        channelRef.current?.postMessage('changed');
      } catch {
        // A closed channel is not worth failing a save for.
      }
    };

    const freshClip = async (store: ClipStore, id: string): Promise<ClipRecord> => {
      const raw = await store.getClip(id);
      if (!raw) throw new Error(CLIP_GONE);
      const i = inspectClipRecord(raw);
      if (!i.ok) throw new Error(i.reason === 'newer' ? 'This clip was saved by a newer version of Mimic. Update the app to change it.' : 'This clip could not be read.');
      return i.clip;
    };

    /** The clip is in its singer's measured targets right now (the flag alone can be stale: the Studio can clear them). */
    const isContributing = (clip: ClipRecord): boolean => {
      const a = appRef.current;
      if (!clip.contributesToSinger || !clip.singerId) return false;
      if (!a) return true;
      return (a.state.measurements[clip.singerId] ?? []).some((m) => m.id === clip.id);
    };

    /** The store just did real work: whatever error state an earlier failure left behind is over. */
    const healthy = (): void => {
      if (stateRef.current.status === 'error') send({ type: 'recovered' });
    };

    /** Takes the clip out of every singer's measured targets (the stored flag can be stale, so look at the targets themselves). */
    const dropMeasured = (clipId: string): void => {
      const a = appRef.current;
      if (!a) return;
      for (const [singerId, list] of Object.entries(a.state.measurements)) if (list.some((m) => m.id === clipId)) a.removeMeasuredClip(singerId, clipId);
    };

    const putAndShow = async (store: ClipStore, clip: ClipRecord): Promise<void> => {
      await store.putClip(clip);
      healthy();
      send({ type: 'clip/put', clip });
      notifyTabs();
    };

    // Each clip is read, rebuilt and written inside that clip's own queue, the one a saved take uses: a take that finishes while a
    // backup is being merged is applied before or after the rebuild, never in between (its attempt count would be lost).
    const rebuildClips = async (store: ClipStore, clipIds: Iterable<string>): Promise<void> => {
      for (const id of new Set(clipIds)) {
        await queue(id, async () => {
          const clip = await store.getClip(id).then((raw) => {
            const i = raw ? inspectClipRecord(raw) : null;
            return i && i.ok ? i.clip : null;
          });
          if (!clip) return;
          const phrases: PhraseRecord[] = [];
          for (const p of clip.phrases) phrases.push(rebuildPhraseState(p, await store.listAttempts({ phraseId: p.id, clipId: id })));
          await putAndShow(store, { ...clip, phrases });
        });
      }
    };

    const reloadRecent = async (store: ClipStore): Promise<void> => {
      send({ type: 'recent/replace', recent: recentFromAttempts(await store.listRecentAttempts(RECENT_PER_PHRASE)) });
    };

    const markDone = async (store: ClipStore, at: string, attemptsSince: number): Promise<void> => {
      try {
        await store.setMeta(META.lastExportAt, at);
        await store.setMeta(META.attemptsSinceExport, attemptsSince);
        send({ type: 'export', lastExportAt: at, attemptsSinceExport: attemptsSince });
      } catch {
        // The backup itself is what matters.
      }
    };

    const bumpAttemptCount = async (store: ClipStore): Promise<void> => {
      const n = ((await store.getMeta<number>(META.attemptsSinceExport)) ?? 0) + 1;
      await store.setMeta(META.attemptsSinceExport, n);
      send({ type: 'export', lastExportAt: stateRef.current.lastExportAt, attemptsSinceExport: n });
    };

    const spaceError = (prepared: PreparedClip, edits: { trim?: { startSec: number; endSec: number }; vocalStem?: unknown }): QuotaError | null => {
      const sec = edits.trim ? Math.max(0, edits.trim.endSec - edits.trim.startSec) : prepared.durationSec;
      const frames = sec * Math.min(prepared.sampleRate, MAX_STORE_RATE);
      const check = checkImportSpace(estimateImportBytes(frames, { stem: !!edits.vocalStem }), stateRef.current.storage);
      if (check.level !== 'insufficient') return null;
      const err = new QuotaError(check.message ?? 'Not enough room on this device for this clip.', check.needBytes);
      return err;
    };

    const maybeRequestPersistence = (): void => {
      // Called first thing in the tap that saves a clip, so the browser sees the gesture.
      if (persistAskedRef.current || stateRef.current.storage.persisted === true) return;
      persistAskedRef.current = true;
      void askForPersistence().then(async (granted) => {
        void granted;
        try {
          await storeRef.current?.setMeta(META.lastPersistRequestAt, iso());
        } catch {
          // Only a note for Settings.
        }
        void refreshStorage();
      });
    };

    const importer = (): TrainerImporter => ({
      prepareClip: importModule.prepareClip,
      commitClip: importModule.commitClip,
      relinkAudio: importModule.relinkAudio,
      ...propsRef.current.importer,
    });

    // -----------------------------------------------------------------------------------------

    const recordAttempt = (clipId: string): PracticeSession['recordAttempt'] => (attempt, recording) =>
      queue(clipId, () =>
        guard(async () => {
          const store = await getStore();
          if (attempt.clipId !== clipId) throw new Error('That attempt belongs to a different clip.');
          const clip = await freshClip(store, clipId);
          const phrase = clip.phrases.find((p) => p.id === attempt.phraseId);
          if (!phrase) throw new Error('That phrase is no longer in the clip.');
          if (attempt.trust === 'invalid') {
            return { saved: false, phrase, notice: 'This take sounded like the playback, not you, so it was not counted. Use headphones and try again.' };
          }
          const history = await store.listAttempts({ phraseId: phrase.id, limit: HISTORY_FOR_REVIEW });
          let notice: string | null = null;
          try {
            await store.addAttempt(attempt, recording);
          } catch (err) {
            if (!(err instanceof QuotaError) || !recording) throw err;
            await store.addAttempt(attempt);
            notice = 'There is not enough room to keep the recording, so only the score was saved. Free some space or turn off "Keep my recordings".';
          }
          if (recording && !notice) await store.trimAttemptAudio(KEEP_RECORDINGS_PER_PHRASE).catch(() => 0);
          if (phrase.stats.attempts + 1 > MAX_ATTEMPTS_PER_PHRASE) await store.deleteAttempts({ phraseId: phrase.id, keepLast: MAX_ATTEMPTS_PER_PHRASE }).catch(() => 0);
          const stored: AttemptRecord = { ...attempt, hasAudio: !!recording && !notice };
          const updated = applyAttempt(phrase, history, stored);
          await putAndShow(store, { ...clip, phrases: clip.phrases.map((p) => (p.id === phrase.id ? updated : p)) });
          send({ type: 'recent/set', phraseId: phrase.id, attempts: recentFromAttempts([...history, stored])[phrase.id] ?? [] });
          await bumpAttemptCount(store).catch(() => undefined);
          return { saved: true, phrase: updated, notice };
        }),
      );

    const controller = {
      updateClip: (id: string, patch: Parameters<TrainerController['updateClip']>[1]): Promise<void> =>
        queue(id, () =>
          guard(async () => {
            const store = await getStore();
            const clip = await freshClip(store, id);
            const a = appRef.current;
            let next = applyClipPatch(clip, patch, iso(), a ? new Set(a.builtins.map((b) => b.id)) : null);
            const contributing = isContributing(clip);
            let after: (() => void) | null = null;
            if (!contributing) {
              if (clip.contributesToSinger) next = { ...next, contributesToSinger: false }; // the flag was stale
            } else if (a && clip.singerId) {
              const oldSinger = clip.singerId;
              if (next.singerId !== oldSinger) {
                if (next.singerId !== null && contributionBlocker(next) === null) {
                  const singer = next.singerId;
                  after = () => (a.removeMeasuredClip(oldSinger, clip.id), a.addMeasuredClip(singer, measuredFromClip(next)));
                } else {
                  next = { ...next, contributesToSinger: false };
                  after = () => a.removeMeasuredClip(oldSinger, clip.id);
                }
              } else if (next.title !== clip.title) {
                after = () => a.addMeasuredClip(oldSinger, measuredFromClip(next));
              }
            }
            await putAndShow(store, next);
            after?.();
          }),
        ),

      updatePhrases: (clipId: string, phrases: PhraseRecord[]): Promise<void> =>
        queue(clipId, () =>
          guard(async () => {
            const store = await getStore();
            const clip = await freshClip(store, clipId);
            const next = { ...clip, phrases: normalizePhrases(phrases, clip.durationSec), updatedAt: iso() };
            await putAndShow(store, next);
          }),
        ),

      deleteClip: (id: string): Promise<void> =>
        queue(id, () =>
          guard(async () => {
            const store = await getStore();
            await store.deleteClip(id);
            clearPhraseAnalysisCache(); // a few analyses held for open phrases; none should outlive their clip
            healthy();
            send({ type: 'clip/remove', id });
            dropMeasured(id);
            notifyTabs();
            void refreshStorage();
          }),
        ),

      setContributes: (clipId: string, on: boolean): Promise<void> =>
        queue(clipId, () =>
          guard(async () => {
            const a = appRef.current;
            if (!a) throw new Error('Singer targets are not available here.');
            const store = await getStore();
            const clip = await freshClip(store, clipId);
            if (on) {
              const why = contributionBlocker(clip);
              if (why) throw new Error(why);
              const singerId = clip.singerId as string;
              if (!a.builtins.some((b) => b.id === singerId)) throw new Error('Choose one of the singers in the list first.');
              a.addMeasuredClip(singerId, measuredFromClip(clip));
              try {
                await putAndShow(store, { ...clip, contributesToSinger: true, updatedAt: iso() });
              } catch (err) {
                a.removeMeasuredClip(singerId, clip.id); // not stored, so not counted
                throw err;
              }
            } else {
              dropMeasured(clip.id);
              await putAndShow(store, { ...clip, contributesToSinger: false, updatedAt: iso() });
            }
          }),
        ),

      exportLibrary: (options?: { markDone?: boolean }): Promise<Blob> =>
        queue('*library*', () =>
          guard(async () => {
            const store = await getStore();
            const warnings: string[] = [];
            // `complete` is false when something that EXISTS could not be read: such a file is still worth saving, but it is not
            // "a backup", so it does not clear the reminder. Records the app cannot open at all (a newer version's, damaged ones)
            // are reported but do not hold the reminder on: no later try would include them.
            let complete = true;
            let clips: ClipRecord[];
            let attempts: AttemptRecord[] = [];
            let calibration: Record<string, number> = {};
            try {
              const raw = await store.listClips();
              clips = [];
              let unreadable = 0;
              for (const r of raw) {
                const i = inspectClipRecord(r);
                if (i.ok) clips.push(i.clip);
                else unreadable++;
              }
              if (unreadable > 0) warnings.push(`${unreadable} saved ${unreadable === 1 ? 'clip' : 'clips'} could not be read by this version of Mimic and ${unreadable === 1 ? 'is' : 'are'} not in this backup.`);
            } catch {
              // A library that cannot be read back still gets a file of what the screen is showing, labelled as partial.
              clips = stateRef.current.clips;
              complete = false;
              warnings.push('Your saved clips could not be read, so this file holds only the clips on screen and may be missing some.');
            }
            try {
              attempts = await store.listAttempts({});
            } catch {
              complete = false;
              warnings.push('Your practice history (scores and attempts) could not be read, so it is not in this file.');
            }
            try {
              calibration = (await store.getMeta<Record<string, number>>(META.calibration)) ?? {};
            } catch {
              // The microphone timing is learned again within a few takes; it is not worth a warning.
            }
            const lib = buildLibraryExport(clips, attempts, calibration, new Date((propsRef.current.now ?? Date.now)()));
            const blob = new Blob([JSON.stringify(lib)], { type: 'application/json' });
            lastExport.current = { complete, warnings, clips: lib.clips.length, attempts: lib.attempts.length };
            pendingExport.current = null;
            if (!complete) return blob; // not counted as a backup: the reminder stays
            if (options?.markDone === false) {
              pendingExport.current = { at: lib.exportedAt, attemptsAtBuild: stateRef.current.attemptsSinceExport };
            } else {
              await markDone(store, lib.exportedAt, 0);
            }
            return blob;
          }),
        ),

      markExported: (): Promise<void> =>
        queue('*library*', () =>
          guard(async () => {
            const pending = pendingExport.current;
            if (!pending) return;
            pendingExport.current = null;
            const store = await getStore();
            // Attempts saved while the share sheet was open are not in the file: they still count toward the next reminder.
            const since = Math.max(0, stateRef.current.attemptsSinceExport - pending.attemptsAtBuild);
            await markDone(store, pending.at, since);
          }),
        ),

      importLibrary: (file: File): Promise<{ added: number; updated: number; warnings: string[] }> =>
        queue('*library*', () =>
          guard(async () => {
            if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is far larger than a Mimic backup. Choose the .json file made with "Export my library".');
            const parsed = parseLibraryText(await file.text());
            if (!parsed.ok) throw new Error(parsed.error);
            const store = await getStore();
            const warnings = [...parsed.warnings];
            const existing = (await store.listClips()).flatMap((r) => {
              const i = inspectClipRecord(r);
              return i.ok ? [i.clip] : [];
            });
            const merged = mergeLibrary(existing, parsed.value.clips);
            const before = new Map(existing.map((c) => [c.id, c]));
            const changed = merged.clips.filter((c) => before.get(c.id) !== undefined ? JSON.stringify(before.get(c.id)) !== JSON.stringify(c) : true);
            // Each changed clip is written inside its own queue, merged again with what is on the device at that moment: a take saved
            // while the backup was being read has already updated the phrase's counts, and the write must not go back over it.
            const incomingById = new Map(parsed.value.clips.map((c) => [c.id, c]));
            const written = new Map<string, ClipRecord>();
            for (const c of changed) {
              await queue(c.id, async () => {
                const raw = await store.getClip(c.id);
                const inspected = raw ? inspectClipRecord(raw) : null;
                const current = inspected && inspected.ok ? inspected.clip : null;
                const incoming = incomingById.get(c.id);
                const next = current && incoming ? mergeLibrary([current], [incoming]).clips[0] : current ?? c;
                if (!current || JSON.stringify(current) !== JSON.stringify(next)) await store.putClip(next);
                written.set(c.id, next);
              });
            }
            const finalClips = merged.clips.map((c) => written.get(c.id) ?? c);

            const knownIds = new Set((await store.listAttempts({})).map((x) => x.id));
            const picked = selectNewAttempts(finalClips, knownIds, parsed.value.attempts);
            if (picked.skippedOrphans) warnings.push(`${picked.skippedOrphans} practice ${picked.skippedOrphans === 1 ? 'attempt was' : 'attempts were'} skipped because ${picked.skippedOrphans === 1 ? 'its phrase has' : 'their phrases have'} been edited or removed since the backup.`);
            for (let i = 0; i < picked.attempts.length; i += 50) await Promise.all(picked.attempts.slice(i, i + 50).map((x) => store.addAttempt(x)));
            await rebuildClips(store, picked.attempts.map((x) => x.clipId));

            const local = (await store.getMeta<Record<string, number>>(META.calibration)) ?? {};
            const learned = { ...parsed.value.calibration, ...local };
            if (Object.keys(learned).length > Object.keys(local).length) await store.setMeta(META.calibration, learned);

            // Targets measured from imported clips come back with them, as far as the app still allows.
            const a = appRef.current;
            const touchedIds = new Set(changed.map((c) => c.id));
            if (a) {
              for (const c of finalClips) {
                if (!touchedIds.has(c.id)) continue;
                if (!c.contributesToSinger) {
                  // A newer copy that does not count (or no longer counts): the singer's measured targets must not keep it.
                  dropMeasured(c.id);
                  continue;
                }
                const ok = contributionBlocker(c) === null && c.singerId !== null && a.builtins.some((b) => b.id === c.singerId);
                if (ok) a.addMeasuredClip(c.singerId as string, measuredFromClip(c));
                else await store.putClip({ ...c, contributesToSinger: false });
              }
            }

            const loaded = await loadLibrary(store);
            send({ type: 'loaded', ...loaded, warnings: [...loaded.warnings], memoryReason: memoryRef.current.reason, memoryRetryable: memoryRef.current.retryable });
            notifyTabs();
            void refreshStorage();
            return { added: merged.added, updated: merged.updated, warnings };
          }),
        ),

      prepareClip: async (file: File, onProgress?: (p: ImportProgress) => void, signal?: AbortSignal, prepareOptions?: { isolate?: importModule.IsolateRequest }): Promise<PreparedClip> => {
        const extra = { ...(signal ? { signal } : {}), ...(prepareOptions?.isolate ? { isolate: prepareOptions.isolate } : {}) };
        const prepared = await importer().prepareClip(file, settings(), onProgress, Object.keys(extra).length > 0 ? extra : undefined);
        const check = checkImportSpace(estimateImportBytes(prepared.samples.length * (Math.min(prepared.sampleRate, MAX_STORE_RATE) / prepared.sampleRate)), stateRef.current.storage);
        return check.message ? { ...prepared, warnings: [...prepared.warnings, check.message] } : prepared;
      },

      commitClip: (prepared: PreparedClip, edits: CommitEdits, onProgress?: (p: ImportProgress) => void): Promise<ClipRecord> => {
        maybeRequestPersistence();
        return guard(async () => {
          // Memory-only because the library failed to open (not because the browser refuses to store): look again before the clip,
          // which took minutes to analyse, goes into a place that is lost when the app closes.
          if (stateRef.current.status === 'memory-only' && stateRef.current.memoryRetryable) await recoverRef.current?.();
          const store = await getStore();
          const roomError = spaceError(prepared, edits);
          if (roomError) throw roomError;
          const before = new Set((await store.listClips()).map((c) => c.id));
          const tracked = trackWrites(store);
          try {
            const result = await importer().commitClip(prepared, edits, tracked.store, onProgress);
            let clip = result.clip;
            const a = appRef.current;
            const wantsTargets = edits.contributeToSinger && !!result.measured && clip.singerId !== null && !!a && a.builtins.some((b) => b.id === clip.singerId);
            clip = { ...clip, contributesToSinger: wantsTargets };
            await store.putClip(clip);
            if (wantsTargets && a && result.measured) a.addMeasuredClip(clip.singerId as string, result.measured);
            send({ type: 'clip/put', clip });
            notifyTabs();
            void refreshStorage();
            return clip;
          } catch (err) {
            // A clip is either fully stored or absent: take back whatever this import already wrote.
            for (const id of tracked.touched) if (!before.has(id)) await store.deleteClip(id).catch(() => undefined);
            throw err;
          }
        });
      },

      relinkClip: (clipId: string, prepared: PreparedClip): Promise<ClipRecord> =>
        queue(clipId, () =>
          guard(async () => {
            const store = await getStore();
            const clip = await freshClip(store, clipId);
            if (!clip.audioMissing) throw new Error('This clip already has its audio on this device.');
            const roomError = spaceError(prepared, {});
            if (roomError) throw roomError;
            const relinked = await importer().relinkAudio(clip, prepared, store);
            const next = { ...relinked, audioMissing: false };
            await putAndShow(store, next);
            void refreshStorage();
            return next;
          }),
        ),

      readClipSamples: (clipId: string): Promise<{ samples: Float32Array; sampleRate: number; source: 'mix' | 'vocal' } | null> =>
        guard(async () => {
          const store = await getStore();
          const clip = await freshClip(store, clipId);
          if (clip.audioMissing) return null;
          const info = clip.audio.vocal ?? clip.audio.mix;
          const samples = await store.readAudio(clip.id, info, 0, info.frames / info.sampleRate + 1);
          return { samples, sampleRate: info.sampleRate, source: info.kind };
        }),

      listAttempts: (filter: { phraseId?: string; clipId?: string; limit?: number }): Promise<AttemptRecord[]> => guard(async () => (await getStore()).listAttempts(filter)),

      deleteAttempts: (filter: { phraseId?: string; clipId?: string }): Promise<number> =>
        queue('*library*', () =>
          guard(async () => {
            const store = await getStore();
            const removed = await store.deleteAttempts(filter);
            // The phrase fields are a cache of the attempts: rebuild them from what is left.
            const clipIds = filter.clipId
              ? [filter.clipId]
              : filter.phraseId
                ? [findPhrase(stateRef.current.clips, filter.phraseId)?.clip.id].flatMap((x) => (x ? [x] : []))
                : stateRef.current.clips.map((c) => c.id);
            await rebuildClips(store, clipIds);
            await reloadRecent(store);
            notifyTabs();
            return removed;
          }),
        ),

      openPractice: (clipId: string, phraseId: string): Promise<PracticeEngine> =>
        guard(async () => {
          const factory = propsRef.current.openPractice;
          if (!factory) throw new Error('Practice is not connected to the audio engine yet.');
          const store = await getStore();
          const clip = await freshClip(store, clipId);
          const phrase = clip.phrases.find((p) => p.id === phraseId);
          if (!phrase) throw new Error('That phrase is no longer in the clip.');
          if (clip.audioMissing) throw new Error('This clip needs its audio file again. Add the file from your device to practise it.');
          return factory({
            clip,
            phrase,
            store,
            settings: settings(),
            recordAttempt: recordAttempt(clipId),
            getCalibration: async () => (await store.getMeta<Record<string, number>>(META.calibration)) ?? {},
            setCalibration: async (route, offsetMs) => {
              if (!route || !Number.isFinite(offsetMs)) return;
              const current = (await store.getMeta<Record<string, number>>(META.calibration)) ?? {};
              await store.setMeta(META.calibration, { ...current, [route]: offsetMs });
            },
          });
        }),

      clearAll: (): Promise<void> => {
        // "Delete everything" can arrive twice (the app's hook and a screen's own call): the second one shares the first one's run.
        if (clearing.current) return clearing.current;
        const run = queue('*library*', () =>
          guard(async () => {
            const store = await getStore();
            const ids = stateRef.current.clips.map((c) => c.id);
            await store.clearAll();
            clearPhraseAnalysisCache();
            healthy();
            send({ type: 'reset' });
            for (const id of ids) dropMeasured(id);
            notifyTabs();
            void refreshStorage();
          }),
        );
        const tracked = run.finally(() => {
          if (clearing.current === tracked) clearing.current = null;
        });
        clearing.current = tracked;
        return tracked;
      },
    };

    const loadOnce = async (): Promise<void> => {
      const store = await getStore();
      const loaded = await guard(() => loadLibrary(store));
      send({ type: 'loaded', ...loaded, memoryReason: memoryRef.current.reason, memoryRetryable: memoryRef.current.retryable });
    };

    const requestPersistence = async (): Promise<boolean> => {
      const granted = await askForPersistence();
      try {
        await storeRef.current?.setMeta(META.lastPersistRequestAt, iso());
      } catch {
        // Only a note for Settings.
      }
      await refreshStorage();
      return granted;
    };

    return { controller, loadOnce, requestPersistence };
  }, [queue, refreshStorage, send]);

  // Open the store and load the library; reload when another tab changes it; and, while the library is memory-only only because
  // opening it failed in a way that can pass, open it again when asked (reload, a clip about to be saved, the app coming back).
  useEffect(() => {
    let alive = true;
    let owned: ClipStore | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let channel: BroadcastChannel | null = null;
    let lastTry = Date.now();
    let recovering: Promise<boolean> | null = null;
    /** The in-memory store standing in for IndexedDB after a failed open (null when the real library is open). */
    let fallbackStore: ClipStore | null = null;

    /** The open, with a bound of its own: an injected or custom opener that never settles must not leave "Opening your library" up. */
    const openWithWatchdog = async (): Promise<OpenedStore> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), propsRef.current.openWatchdogMs ?? OPEN_WATCHDOG_MS);
      });
      const opening = openClipStoreWithFallback(propsRef.current.openStore);
      const first = await Promise.race([opening, slow]);
      clearTimeout(timer);
      if (first === 'slow') {
        void opening.then((late) => late.store.close()); // it arrived too late to be used: do not leak the connection
        return { store: createMemoryClipStore(), fallback: { reason: OPEN_TIMEOUT_MESSAGE, retryable: true } };
      }
      return first;
    };

    const attachSync = (store: ClipStore): void => {
      const sync = propsRef.current.syncTabs ?? store.kind === 'indexeddb';
      if (!alive || !sync || channel || typeof BroadcastChannel !== 'function') return;
      try {
        channel = new BroadcastChannel(CHANNEL);
        channelRef.current = channel;
        channel.onmessage = () => {
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => void actions.loadOnce().catch(() => undefined), 250);
        };
      } catch {
        channel = null;
      }
    };

    /** Chunks whose clip record is missing (an import killed half way by an older version) are removed once per open. */
    const sweep = (store: ClipStore): void => {
      if (store.kind !== 'indexeddb') return;
      void store
        .pruneOrphanAudio()
        .then((n) => (n > 0 && alive ? refreshStorage() : undefined))
        .catch(() => undefined);
    };

    const recover = (): Promise<boolean> => {
      if (!alive || !fallbackStore || !retryRef.current) return Promise.resolve(false);
      if (!recovering) {
        lastTry = Date.now();
        recovering = queue('*library*', async () => {
          const memory = fallbackStore;
          if (!alive || !memory) return false;
          const attempt = await openWithWatchdog();
          if (attempt.fallback) {
            attempt.store.close();
            retryRef.current = attempt.fallback.retryable;
            return false;
          }
          if (!alive) {
            attempt.store.close();
            return false;
          }
          const real = attempt.store;
          let copied = { clips: 0, attempts: 0 };
          try {
            copied = await copyLibrary(memory, real);
          } catch {
            real.close(); // the session's clips stay in memory; whatever was copied is a complete clip or swept chunks
            return false;
          }
          storeRef.current = real;
          owned = real;
          fallbackStore = null;
          memory.close();
          retryRef.current = false;
          memoryRef.current = { reason: null, retryable: false };
          attachSync(real);
          const loaded = await loadLibrary(real);
          const note = copied.clips > 0 ? [`Your library opened again. ${copied.clips === 1 ? 'The clip' : `The ${copied.clips} clips`} you added in this session ${copied.clips === 1 ? 'was' : 'were'} copied into it.`] : [];
          if (alive) dispatch({ type: 'loaded', ...loaded, warnings: [...note, ...loaded.warnings], memoryReason: null });
          sweep(real);
          void refreshStorage();
          return true;
        })
          .catch(() => false)
          .finally(() => {
            recovering = null;
          });
      }
      return recovering;
    };
    recoverRef.current = recover;

    const run = (async () => {
      let store = injected;
      let reason: string | null = null;
      let retryable = false;
      if (!store) {
        const opened = await openWithWatchdog();
        if (!alive) {
          opened.store.close(); // unmounted while IndexedDB was opening (React StrictMode does this)
          return;
        }
        store = opened.store;
        owned = store;
        reason = opened.fallback?.reason ?? null;
        retryable = opened.fallback?.retryable ?? false;
        fallbackStore = opened.fallback ? store : null;
        retryRef.current = retryable;
        memoryRef.current = { reason, retryable };
        lastTry = Date.now();
      }
      storeRef.current = store;
      try {
        const loaded = await loadLibrary(store);
        if (alive) dispatch({ type: 'loaded', ...loaded, memoryReason: reason, memoryRetryable: retryable });
        if (alive && owned) sweep(store);
      } catch (err) {
        if (alive) dispatch({ type: 'failed', message: errorMessage(err, 'The library could not be read. Export a backup, then reload the app.') });
      }
      attachSync(store);
      if (alive) void refreshStorage();
    })();
    loadedRef.current = run;

    const onForeground = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (fallbackStore && retryRef.current && Date.now() - lastTry >= RETRY_OPEN_EVERY_MS) void recover();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      alive = false;
      recoverRef.current = null;
      clearTimeout(reloadTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      channel?.close();
      channelRef.current = null;
      storeRef.current = null;
      owned?.close();
    };
  }, [injected, actions, refreshStorage, queue]);

  // The practice queue depends on the date: look again when the app comes back to the foreground.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tick = () => {
      if (document.visibilityState !== 'hidden') dispatch({ type: 'tick', now: (propsRef.current.now ?? Date.now)() });
    };
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);

  // AppController.clearAllData should also wipe the library: it calls every hook registered here.
  const onClear = app?.onClear;
  useEffect(() => {
    if (typeof onClear !== 'function') return;
    return onClear(() => actions.controller.clearAll(), 'your clips and practice scores');
  }, [onClear, actions]);

  const singerIds = app?.builtins;
  const measurements = app?.state.measurements;
  const clips = useMemo(() => {
    // The flag on the clip says what was asked for; the measured targets say what is in effect.
    if (!measurements) return state.clips;
    return state.clips.map((c) => {
      if (!c.contributesToSinger) return c;
      const present = !!c.singerId && (measurements[c.singerId] ?? []).some((m) => m.id === c.id);
      return present ? c : { ...c, contributesToSinger: false };
    });
  }, [state.clips, measurements]);

  const queueItems = useMemo(() => selectQueue({ clips, recent: state.recent, now: state.now }), [clips, state.recent, state.now]);

  const value = useMemo<TrainerController>(() => {
    const c = actions.controller;
    return {
      status: state.status,
      error: state.error,
      clips,
      storage: state.storage,
      singers: singerIds ?? [],
      queue: queueItems,
      getClip: (id: string) => clips.find((x) => x.id === id),
      updateClip: c.updateClip,
      updatePhrases: c.updatePhrases,
      deleteClip: c.deleteClip,
      setContributes: c.setContributes,
      exportLibrary: c.exportLibrary,
      markExported: c.markExported,
      lastExportReport: () => lastExport.current,
      readClipSamples: c.readClipSamples,
      importLibrary: c.importLibrary,
      prepareClip: c.prepareClip,
      commitClip: c.commitClip,
      relinkClip: c.relinkClip,
      listAttempts: c.listAttempts,
      deleteAttempts: c.deleteAttempts,
      openPractice: c.openPractice,
      clearAll: c.clearAll,
    };
  }, [actions, state.status, state.error, state.storage, clips, singerIds, queueItems]);

  const extras = useMemo<TrainerExtras>(() => {
    const memoryOnly = state.status === 'memory-only';
    const oldest = state.clips.reduce<string | null>((o, c) => (o === null || Date.parse(c.addedAt) < Date.parse(o) ? c.addedAt : o), null);
    return {
      memoryReason: state.memoryReason,
      canRetryOpen: memoryOnly && state.memoryRetryable,
      warnings: state.warnings,
      exportReminder: computeExportReminder({ clipCount: state.clips.length, attemptsSinceExport: state.attemptsSinceExport, lastExportAt: state.lastExportAt, oldestClipAt: oldest }, state.now),
      storageNote: state.status === 'loading' ? null : storageNote(state.storage, { memoryOnly, installed: isInstalledPwa() }),
      reload: async () => {
        // A recovery has just read the library it opened; otherwise read the one that is open again.
        if (!(await recoverRef.current?.())) await actions.loadOnce();
      },
      refreshStorage,
      requestPersistence: actions.requestPersistence,
    };
  }, [state.status, state.memoryReason, state.memoryRetryable, state.warnings, state.clips, state.attemptsSinceExport, state.lastExportAt, state.now, state.storage, actions, refreshStorage]);

  return (
    <TrainerContext.Provider value={value}>
      <TrainerExtrasContext.Provider value={extras}>{children}</TrainerExtrasContext.Provider>
    </TrainerContext.Provider>
  );
}
