// The clip library's storage: a ClipStore interface with two implementations that obey the same contract
// (storage/clipStoreContract.ts runs one suite against both).
//
//   openClipStore()          IndexedDB, no dependencies. db "mimic-trainer" v1
//     clips        keyPath id                       ClipRecord (metadata + phrases, ~10 KB)
//     audio        keyPath [clipId, kind, index]    10 s Int16 chunks {clipId, kind, index, bytes, pcm: ArrayBuffer}; indexes byClip, byBytes
//     attempts     keyPath id                       AttemptRecord (~2 KB); indexes byPhrase [phraseId, at], byClip [clipId, at]
//     attemptAudio keyPath id                       optional rolling recordings {id, phraseId, at, sampleRate, bytes, pcm}; indexes byPhrase, byBytes
//     meta         keyPath key                      {key, value}: calibration, lastExportAt, ...
//   createMemoryClipStore()  the test double and the "memory-only" fallback when IndexedDB is unavailable or broken.
//
// `bytes` and the byBytes indexes exist so usage() can add up the audio size from index keys alone; reading every
// chunk of a 100 MB library to show one number would hurt on a phone.
//
// Rules: every multi-record write is ONE transaction (a failure - quota, abort, a throw while building the writes - leaves
// the previous state, never half a clip); QuotaExceededError becomes QuotaError; a connection that Safari drops or another
// tab closes is reopened once per call; opening is retried twice for the errors Safari throws at random (UnknownError,
// AbortError, InvalidStateError) and gives up after a timeout instead of waiting for ever; opening is verified with a write so
// a browser that opens but cannot store is reported as unavailable rather than failing later.

import { CHUNK_SEC, chunkFramesFor, chunkRanges, chunksFor, floatToInt16, sliceChunks } from '../audio/pcm';
import type { AttemptRecord, ClipAudioInfo, ClipRecord } from '../types';

/**
 * Why the library could not be opened. 'transient': the browser threw one of its random errors (worth retrying at once);
 * 'timeout': the open request never answered; 'blocked': another tab holds an older version; 'other': a refusal that trying
 * again will not change (no IndexedDB, a private mode, a newer database version).
 */
export type StoreFailure = 'transient' | 'timeout' | 'blocked' | 'other';

export class StoreUnavailableError extends Error {
  readonly failure: StoreFailure;
  constructor(message: string, failure: StoreFailure = 'other') {
    super(message);
    this.name = 'StoreUnavailableError';
    this.failure = failure;
  }
  /** Trying again later (a tap on "Try again", the app coming back to the foreground) can succeed. */
  get retryable(): boolean {
    return this.failure !== 'other';
  }
}

export class QuotaError extends Error {
  needBytes: number | null;
  constructor(message: string, needBytes: number | null = null) {
    super(message);
    this.name = 'QuotaError';
    this.needBytes = needBytes;
  }
}

/** The clip's audio is not on this device (never imported here, or removed). The message names the fix. */
export class AudioMissingError extends Error {
  constructor(message = 'The clip audio is missing from this device. Add the file again.') {
    super(message);
    this.name = 'AudioMissingError';
  }
}

export interface AttemptFilter {
  phraseId?: string;
  clipId?: string;
  /** A positive whole number caps the result; anything else (0, undefined) means no cap. */
  limit?: number;
}

export interface ClipStore {
  readonly kind: 'indexeddb' | 'memory';
  /** Newest `addedAt` first. */
  listClips(): Promise<ClipRecord[]>;
  getClip(id: string): Promise<ClipRecord | null>;
  /** Atomic with respect to the clip record only. Replaces a record with the same id. */
  putClip(clip: ClipRecord): Promise<void>;
  /** Removes the clip, its audio chunks, attempts and attempt audio in one transaction. A clip that is not there is not an error. */
  deleteClip(id: string): Promise<void>;
  /** Writes (replacing) `kind` audio of a clip as 10 s chunks in one transaction; rejects with QuotaError if the browser refuses, leaving the old audio. */
  writeAudio(clipId: string, kind: 'mix' | 'vocal', pcm: Int16Array, sampleRate: number): Promise<ClipAudioInfo>;
  /** Mono float samples of [fromSec, toSec) at the stored rate, clamped to the clip. Rejects with AudioMissingError when the chunks are not there. */
  readAudio(clipId: string, info: ClipAudioInfo, fromSec: number, toSec: number): Promise<Float32Array>;
  deleteAudio(clipId: string, kind: 'mix' | 'vocal'): Promise<void>;
  /** The stored record's `hasAudio` always matches whether `audio` was given. Adding an id that exists replaces it. */
  addAttempt(a: AttemptRecord, audio?: { pcm: Int16Array; sampleRate: number }): Promise<void>;
  /** Newest first (ties: larger id first). With both ids, an attempt must match both. */
  listAttempts(filter: AttemptFilter): Promise<AttemptRecord[]>;
  /** The newest `perPhrase` attempts of every phrase, newest first within a phrase; the order of phrases is not defined. */
  listRecentAttempts(perPhrase: number): Promise<AttemptRecord[]>;
  readAttemptAudio(attemptId: string): Promise<{ pcm: Int16Array; sampleRate: number } | null>;
  /** Deletes the matching attempts (and their recordings) except the newest `keepLast`; returns how many. No ids = every attempt. */
  deleteAttempts(filter: { phraseId?: string; clipId?: string; keepLast?: number }): Promise<number>;
  /** Drops attempt recordings beyond the newest `keep` per phrase (their records stay, with hasAudio false); returns how many. */
  trimAttemptAudio(keepPerPhrase: number): Promise<number>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** Counts, and the bytes of clip audio plus attempt recordings. */
  usage(): Promise<{ clips: number; attempts: number; audioBytes: number }>;
  /**
   * Removes audio chunks whose clip record does not exist (an import that was killed between writing the audio and the record, by
   * an older version of the app); returns how many clips' worth of chunks were removed. Safe to call on open: the importer writes the
   * clip record first.
   */
  pruneOrphanAudio(): Promise<number>;
  clearAll(): Promise<void>;
  close(): void;
}

/** Keys used in the `meta` store. */
export const META = {
  /** Record<string, number>: median sync offset (ms) per input route kind. */
  calibration: 'calibration',
  /** ISO time of the last library export. */
  lastExportAt: 'lastExportAt',
  /** Attempts saved since the last export (drives the backup reminder). */
  attemptsSinceExport: 'attemptsSinceExport',
  /** ISO time of the last persistence request. */
  lastPersistRequestAt: 'lastPersistRequestAt',
} as const;

export const DB_NAME = 'mimic-trainer';
export const DB_VERSION = 1;

const STORE_NAMES = ['clips', 'audio', 'attempts', 'attemptAudio', 'meta'] as const;
const PROBE_KEY = '__probe';

export type Upgrade = (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void;
/** One function per version step; add `2: (db, tx) => {...}` for the next schema and bump DB_VERSION, never edit an old step. */
export const MIGRATIONS: Readonly<Record<number, Upgrade>> = {
  1: (db) => {
    db.createObjectStore('clips', { keyPath: 'id' });
    const audio = db.createObjectStore('audio', { keyPath: ['clipId', 'kind', 'index'] });
    audio.createIndex('byClip', 'clipId');
    audio.createIndex('byBytes', 'bytes');
    const attempts = db.createObjectStore('attempts', { keyPath: 'id' });
    attempts.createIndex('byPhrase', ['phraseId', 'at']);
    attempts.createIndex('byClip', ['clipId', 'at']);
    const attemptAudio = db.createObjectStore('attemptAudio', { keyPath: 'id' });
    attemptAudio.createIndex('byPhrase', ['phraseId', 'at']);
    attemptAudio.createIndex('byBytes', 'bytes');
    db.createObjectStore('meta', { keyPath: 'key' });
  },
};

// ---------------------------------------------------------------------------------------------
// Shared helpers

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Newest `addedAt` first; ties by id so both stores list in the same order. */
function byAddedDesc(a: ClipRecord, b: ClipRecord): number {
  return time(b.addedAt) - time(a.addedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Newest first; ties by larger id first (what a 'prev' cursor on [phraseId, at] gives). */
function newestFirst(a: AttemptRecord, b: AttemptRecord): number {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function matches(a: AttemptRecord, f: { phraseId?: string; clipId?: string }): boolean {
  return (f.phraseId === undefined || a.phraseId === f.phraseId) && (f.clipId === undefined || a.clipId === f.clipId);
}

function cap<T>(list: T[], limit: number | undefined): T[] {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? list.slice(0, limit) : list;
}

function requireId(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string' || id === '') throw new TypeError(`${what} needs a non-empty id.`);
}

function requireKind(kind: unknown): asserts kind is 'mix' | 'vocal' {
  if (kind !== 'mix' && kind !== 'vocal') throw new TypeError(`Unknown audio kind: ${String(kind)}`);
}

function checkInfo(info: ClipAudioInfo): void {
  if (!(Number.isFinite(info.sampleRate) && info.sampleRate > 0) || !(Number.isInteger(info.chunkFrames) && info.chunkFrames >= 1) || !(Number.isFinite(info.frames) && info.frames >= 0)) {
    throw new RangeError('The clip audio details are not valid.');
  }
}

function checkAttempt(a: AttemptRecord): void {
  requireId(a?.id, 'An attempt');
  requireId(a.clipId, 'An attempt');
  requireId(a.phraseId, 'An attempt');
  if (!Number.isFinite(a.at)) throw new TypeError('An attempt needs a time.');
}

function plainClone<T>(x: T): T {
  return typeof structuredClone === 'function' ? structuredClone(x) : (JSON.parse(JSON.stringify(x)) as T);
}

export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string } | null;
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(e.message ?? ''));
}

/** Errors that mean "this connection is dead" rather than "this request is wrong": Safari's dropped connection, a closing database. */
export function isStaleConnection(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  return e.name === 'InvalidStateError' || e.name === 'UnknownError' || /connection (to indexed database server )?(lost|is closing)|database connection is closing/i.test(e.message ?? '');
}

function mapError(err: unknown, needBytes: number | null = null): Error {
  if (err instanceof QuotaError || err instanceof StoreUnavailableError || err instanceof AudioMissingError) return err;
  if (isQuotaError(err)) {
    return new QuotaError('The device has no room for this clip. Free some space or remove clips you no longer practise.', needBytes);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------------------------
// A connection that is reopened once when it goes stale

export interface Reconnecting<C> {
  run<R>(fn: (c: C) => Promise<R>): Promise<R>;
  /** Forgets `c` (and closes it) if it is still the current connection, so the next call opens a new one. */
  dropIf(c: C): void;
  close(): void;
  readonly closed: boolean;
}

const UNREACHABLE = 'Your library could not be reached. Export a backup, then reload the app.';

/**
 * Runs operations on a lazily opened connection. A stale-connection failure drops the connection, reopens it and tries
 * the operation once more (every operation here is idempotent); a second failure is reported as StoreUnavailableError.
 */
export function createReconnecting<C>(open: () => Promise<C>, dispose: (c: C) => void, isRetryable: (err: unknown) => boolean = isStaleConnection): Reconnecting<C> {
  let conn: C | null = null;
  let opening: Promise<C> | null = null;
  let closed = false;
  const closedError = () => new StoreUnavailableError('The library is closed.');
  const safeDispose = (c: C) => {
    try {
      dispose(c);
    } catch {
      // Already closed.
    }
  };
  const connect = (): Promise<C> => {
    if (closed) return Promise.reject(closedError());
    if (conn !== null) return Promise.resolve(conn);
    if (!opening) {
      opening = open()
        .then((c) => {
          if (closed) {
            safeDispose(c);
            throw closedError();
          }
          conn = c;
          return c;
        })
        .finally(() => {
          opening = null;
        });
    }
    return opening;
  };
  const dropIf = (c: C) => {
    if (conn === c) {
      conn = null;
      safeDispose(c);
    }
  };
  return {
    async run<R>(fn: (c: C) => Promise<R>): Promise<R> {
      const first = await connect();
      try {
        return await fn(first);
      } catch (err) {
        if (closed || !isRetryable(err)) throw err;
        dropIf(first);
      }
      const second = await connect();
      try {
        return await fn(second);
      } catch (err) {
        if (isRetryable(err)) {
          dropIf(second);
          throw new StoreUnavailableError(UNREACHABLE);
        }
        throw err;
      }
    },
    dropIf,
    close() {
      closed = true;
      const c = conn;
      conn = null;
      if (c !== null) safeDispose(c);
    },
    get closed() {
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// IndexedDB plumbing

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

/** Resolves when the transaction commits; rejects with the abort reason. Attach before issuing requests. */
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/**
 * Runs `body` in one readwrite transaction and resolves with its result once the transaction has committed. If `body`
 * throws (a synchronous put can, for quota or a value that cannot be cloned) the transaction is aborted, so nothing it
 * queued is kept.
 */
async function transact<R>(db: IDBDatabase, stores: string[], body: (tx: IDBTransaction) => R | Promise<R>): Promise<R> {
  const tx = db.transaction(stores, 'readwrite');
  const finished = done(tx);
  finished.catch(() => undefined);
  let result: R;
  try {
    result = await body(tx);
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    await finished.catch(() => undefined);
    throw err;
  }
  await finished;
  return result;
}

const audioRange = (clipId: string, kind?: 'mix' | 'vocal'): IDBKeyRange =>
  kind ? IDBKeyRange.bound([clipId, kind, 0], [clipId, kind, Infinity]) : IDBKeyRange.bound([clipId, '', 0], [clipId, '￿', Infinity]);

const phraseRange = (phraseId: string): IDBKeyRange => IDBKeyRange.bound([phraseId, -Infinity], [phraseId, Infinity]);
const clipRange = (clipId: string): IDBKeyRange => IDBKeyRange.bound([clipId, -Infinity], [clipId, Infinity]);

interface AudioRow {
  clipId: string;
  kind: 'mix' | 'vocal';
  index: number;
  bytes: number;
  pcm: ArrayBuffer;
}

interface AttemptAudioRow {
  id: string;
  phraseId: string;
  at: number;
  sampleRate: number;
  bytes: number;
  pcm: ArrayBuffer;
}

export interface OpenClipStoreOptions {
  name?: string;
  version?: number;
  migrations?: Readonly<Record<number, Upgrade>>;
  /** How long to wait for another tab to let go of an older version before giving up. */
  blockedTimeoutMs?: number;
  /** Called with every connection that is opened (tests close it to simulate a dropped connection). */
  onConnection?: (db: IDBDatabase) => void;
  /** How long an open request may stay silent before it is given up on (default 10 s). The same bound applies to the write probe. */
  openTimeoutMs?: number;
  /** Waits before the retries of a transiently failing open (default 250 ms, then 1 s). */
  retryDelaysMs?: readonly number[];
}

/** The errors Safari (and sometimes Chrome) throws for a perfectly good database: a second try usually works. */
const TRANSIENT_OPEN_ERRORS = new Set(['UnknownError', 'AbortError', 'InvalidStateError']);

function openFailure(err: DOMException | Error | null | undefined): StoreUnavailableError {
  const name = err?.name;
  if (name === 'VersionError') return new StoreUnavailableError('This library was saved by a newer version of Mimic. Update the app, then reload.');
  if (name === 'SecurityError') return new StoreUnavailableError('This browser is blocking IndexedDB (private browsing or a restricted frame), so clips cannot be stored.');
  if (name === 'InvalidStateError') return new StoreUnavailableError('This browser is blocking IndexedDB (private browsing or a restricted frame), so clips cannot be stored.', 'transient');
  const failure: StoreFailure = name && TRANSIENT_OPEN_ERRORS.has(name) ? 'transient' : 'other';
  return new StoreUnavailableError(err?.message ? `IndexedDB could not be opened: ${err.message}` : 'IndexedDB could not be opened.', failure);
}

/** Shown when the library does not answer in time: the clips are safe, the door is stuck. */
export const OPEN_TIMEOUT_MESSAGE = 'Your library is taking too long to open. Your saved clips are not deleted. Close and reopen the app, or tap Try again.';
const TIMEOUT_MESSAGE = OPEN_TIMEOUT_MESSAGE;
const BLOCKED_MESSAGE = 'Another tab of Mimic is holding the library. Close it and reload.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with a timeout StoreUnavailableError when `work` has not settled after `ms`. */
function withOpenTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreUnavailableError(TIMEOUT_MESSAGE, 'timeout')), ms);
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function openDatabase(opts: Required<Pick<OpenClipStoreOptions, 'name' | 'version' | 'migrations' | 'blockedTimeoutMs' | 'openTimeoutMs'>>, healed = false): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let idb: IDBFactory | undefined;
    try {
      idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB; // a sandboxed frame throws a SecurityError just for reading this
    } catch (err) {
      return reject(openFailure(err instanceof Error ? err : null));
    }
    if (!idb) return reject(new StoreUnavailableError('This browser does not offer IndexedDB.'));
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(opts.name, opts.version);
    } catch (err) {
      return reject(openFailure(err instanceof Error ? err : null));
    }
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(blockedTimer);
      clearTimeout(openTimer);
      reject(e);
    };
    // A request that never fires success, error or blocked (a known WebKit failure) must not leave "Opening your library" up for ever.
    const arm = (ms: number) => {
      clearTimeout(openTimer);
      openTimer = setTimeout(() => fail(new StoreUnavailableError(TIMEOUT_MESSAGE, 'timeout')), ms);
    };
    arm(opts.openTimeoutMs);
    request.onupgradeneeded = (e) => {
      arm(Math.max(opts.openTimeoutMs, 30_000)); // an upgrade of a big library is real work, not silence
      const db = request.result;
      const tx = request.transaction as IDBTransaction;
      try {
        for (let v = e.oldVersion + 1; v <= (e.newVersion ?? opts.version); v++) {
          const step = opts.migrations[v];
          if (!step) throw new Error(`No migration for database version ${v}.`);
          step(db, tx, e.oldVersion);
        }
      } catch (err) {
        try {
          tx.abort();
        } catch {
          // Already aborted.
        }
        fail(new StoreUnavailableError(`The library could not be upgraded: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    request.onerror = (e) => {
      e?.preventDefault?.();
      fail(openFailure(request.error));
    };
    // Another tab still holds an older version: give it a moment to close (it listens for versionchange), then stop waiting.
    request.onblocked = () => {
      if (!blockedTimer) blockedTimer = setTimeout(() => fail(new StoreUnavailableError(BLOCKED_MESSAGE, 'blocked')), opts.blockedTimeoutMs);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close(); // we gave up waiting; do not leak the connection that arrived late
        return;
      }
      const missing = STORE_NAMES.filter((n) => !db.objectStoreNames.contains(n));
      if (missing.length === 0) {
        settled = true;
        clearTimeout(blockedTimer);
        clearTimeout(openTimer);
        resolve(db);
        return;
      }
      db.close();
      if (missing.length === STORE_NAMES.length && !healed) {
        // An upgrade that was aborted can leave an empty database (a WebKit bug). There is nothing in it to lose: recreate it.
        const del = idb.deleteDatabase(opts.name);
        del.onerror = () => fail(new StoreUnavailableError('The library database is damaged and could not be recreated. Reload, or clear this site\'s data.'));
        del.onsuccess = () => {
          settled = true;
          clearTimeout(blockedTimer);
          clearTimeout(openTimer);
          openDatabase(opts, true).then(resolve, reject);
        };
        del.onblocked = () => fail(new StoreUnavailableError(BLOCKED_MESSAGE, 'blocked'));
        return;
      }
      fail(new StoreUnavailableError('The library database is incomplete. Reload; if this keeps happening, export a backup and clear this site\'s data.'));
    };
  });
}

export function openClipStore(options: OpenClipStoreOptions = {}): Promise<ClipStore> {
  const cfg = {
    name: options.name ?? DB_NAME,
    version: options.version ?? DB_VERSION,
    migrations: options.migrations ?? MIGRATIONS,
    blockedTimeoutMs: options.blockedTimeoutMs ?? 4000,
    openTimeoutMs: options.openTimeoutMs ?? 10_000,
  };
  const retryDelays = options.retryDelaysMs ?? [250, 1000];
  /** Opens, trying again after a short wait when the browser threw one of its random errors. */
  const openWithRetry = async (): Promise<IDBDatabase> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await openDatabase(cfg);
      } catch (err) {
        if (!(err instanceof StoreUnavailableError) || err.failure !== 'transient' || attempt >= retryDelays.length) throw err;
        await sleep(retryDelays[attempt]);
      }
    }
  };
  const conn: Reconnecting<IDBDatabase> = createReconnecting<IDBDatabase>(
    async () => {
      const db = await openWithRetry();
      const lose = () => conn.dropIf(db);
      db.onversionchange = () => {
        // A newer version of the app in another tab wants to upgrade: let go, and reopen on the next call.
        lose();
        try {
          db.close();
        } catch {
          // Already closed.
        }
      };
      db.onclose = lose;
      options.onConnection?.(db);
      return db;
    },
    (db) => db.close(),
  );
  const run = <R>(fn: (db: IDBDatabase) => Promise<R>, needBytes: number | null = null): Promise<R> => conn.run(fn).catch((e) => Promise.reject(mapError(e, needBytes)));

  const store: ClipStore = {
    kind: 'indexeddb',
    async listClips() {
      return run(async (db) => ((await req(db.transaction('clips').objectStore('clips').getAll())) as ClipRecord[]).sort(byAddedDesc));
    },
    async getClip(id) {
      return run(async (db) => ((await req(db.transaction('clips').objectStore('clips').get(id))) as ClipRecord | undefined) ?? null);
    },
    async putClip(c) {
      requireId(c?.id, 'A clip');
      return run((db) => transact(db, ['clips'], (tx) => void tx.objectStore('clips').put(c)));
    },
    async deleteClip(id) {
      return run((db) =>
        transact(db, ['clips', 'audio', 'attempts', 'attemptAudio'], (tx) => {
          tx.objectStore('clips').delete(id);
          tx.objectStore('audio').delete(audioRange(id));
          const attempts = tx.objectStore('attempts');
          const recordings = tx.objectStore('attemptAudio');
          const cur = attempts.index('byClip').openKeyCursor(clipRange(id));
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            attempts.delete(c.primaryKey);
            recordings.delete(c.primaryKey);
            c.continue();
          };
        }),
      );
    },
    async writeAudio(clipId, kind, pcm, sampleRate): Promise<ClipAudioInfo> {
      requireId(clipId, 'Audio');
      requireKind(kind);
      const chunkFrames = chunkFramesFor(sampleRate);
      const ranges = chunkRanges(pcm.length, chunkFrames);
      await run(
        (db) =>
          transact(db, ['audio'], (tx) => {
            const os = tx.objectStore('audio');
            os.delete(audioRange(clipId, kind));
            // One chunk copy at a time: put() clones synchronously, so the slice is free again before the next one is made.
            ranges.forEach(([a, b], index) => {
              const chunk = pcm.slice(a, b);
              const row: AudioRow = { clipId, kind, index, bytes: chunk.byteLength, pcm: chunk.buffer as ArrayBuffer };
              os.put(row);
            });
          }),
        pcm.byteLength,
      );
      return { kind, sampleRate, frames: pcm.length, chunkFrames };
    },
    async readAudio(clipId, info, fromSec, toSec) {
      checkInfo(info);
      const r = chunksFor(fromSec, toSec, info.sampleRate, info.chunkFrames, info.frames);
      if (r.to <= r.from) return new Float32Array(0);
      return run(async (db) => {
        const rows = (await req(db.transaction('audio').objectStore('audio').getAll(IDBKeyRange.bound([clipId, info.kind, r.first], [clipId, info.kind, r.last])))) as AudioRow[];
        if (rows.length !== r.last - r.first + 1) throw new AudioMissingError();
        return sliceChunks(
          rows.map((row) => new Int16Array(row.pcm)),
          r.first,
          info.chunkFrames,
          r.from,
          r.to,
        );
      });
    },
    async deleteAudio(clipId, kind) {
      requireKind(kind);
      return run((db) => transact(db, ['audio'], (tx) => void tx.objectStore('audio').delete(audioRange(clipId, kind))));
    },
    async addAttempt(a, audio) {
      checkAttempt(a);
      const record: AttemptRecord = { ...a, hasAudio: audio !== undefined };
      return run(
        (db) =>
          transact(db, ['attempts', 'attemptAudio'], (tx) => {
            tx.objectStore('attempts').put(record);
            const recordings = tx.objectStore('attemptAudio');
            if (audio) {
              const pcm = audio.pcm.slice();
              const row: AttemptAudioRow = { id: a.id, phraseId: a.phraseId, at: a.at, sampleRate: audio.sampleRate, bytes: pcm.byteLength, pcm: pcm.buffer as ArrayBuffer };
              recordings.put(row);
            } else {
              recordings.delete(a.id); // replacing an attempt must not leave the old recording behind
            }
          }),
        audio ? audio.pcm.byteLength : null,
      );
    },
    async listAttempts(f) {
      return run(async (db) => {
        const os = db.transaction('attempts').objectStore('attempts');
        const index = f.phraseId !== undefined ? os.index('byPhrase') : f.clipId !== undefined ? os.index('byClip') : null;
        const range = f.phraseId !== undefined ? phraseRange(f.phraseId) : f.clipId !== undefined ? clipRange(f.clipId) : undefined;
        const out: AttemptRecord[] = [];
        const limit = typeof f.limit === 'number' && Number.isInteger(f.limit) && f.limit > 0 ? f.limit : Infinity;
        if (!index) return cap(((await req(os.getAll())) as AttemptRecord[]).sort(newestFirst), f.limit);
        await new Promise<void>((resolve, reject) => {
          const cur = index.openCursor(range, 'prev'); // newest first
          cur.onerror = () => reject(cur.error);
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return resolve();
            const a = c.value as AttemptRecord;
            if (matches(a, f)) out.push(a);
            if (out.length >= limit) return resolve();
            c.continue();
          };
        });
        return out;
      });
    },
    async listRecentAttempts(perPhrase) {
      const n = Math.floor(perPhrase);
      if (!(n >= 1)) return [];
      return run(async (db) => {
        const index = db.transaction('attempts').objectStore('attempts').index('byPhrase');
        const out: AttemptRecord[] = [];
        await new Promise<void>((resolve, reject) => {
          let phrase: string | null = null;
          let seen = 0;
          const cur = index.openCursor(null, 'prev');
          cur.onerror = () => reject(cur.error);
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return resolve();
            const a = c.value as AttemptRecord;
            if (a.phraseId !== phrase) {
              phrase = a.phraseId;
              seen = 0;
            }
            out.push(a);
            seen++;
            // Jump past the older attempts of this phrase instead of reading them.
            if (seen >= n) c.continue([a.phraseId, -Infinity]);
            else c.continue();
          };
        });
        return out;
      });
    },
    async readAttemptAudio(id) {
      return run(async (db) => {
        const row = (await req(db.transaction('attemptAudio').objectStore('attemptAudio').get(id))) as AttemptAudioRow | undefined;
        return row ? { pcm: new Int16Array(row.pcm), sampleRate: row.sampleRate } : null;
      });
    },
    async deleteAttempts(f) {
      const keep = f.keepLast !== undefined && Number.isFinite(f.keepLast) ? Math.max(0, Math.floor(f.keepLast)) : 0;
      return run((db) =>
        transact(db, ['attempts', 'attemptAudio'], async (tx) => {
          const attempts = tx.objectStore('attempts');
          const recordings = tx.objectStore('attemptAudio');
          let removed = 0;
          const index = f.phraseId !== undefined ? attempts.index('byPhrase') : f.clipId !== undefined ? attempts.index('byClip') : null;
          if (!index) {
            for (const a of ((await req(attempts.getAll())) as AttemptRecord[]).sort(newestFirst).slice(keep)) {
              attempts.delete(a.id);
              recordings.delete(a.id);
              removed++;
            }
            return removed;
          }
          const range = f.phraseId !== undefined ? phraseRange(f.phraseId) : clipRange(f.clipId as string);
          let seen = 0;
          await new Promise<void>((resolve, reject) => {
            const cur = index.openCursor(range, 'prev'); // newest first: the first `keep` matches stay
            cur.onerror = () => reject(cur.error);
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) return resolve();
              const a = c.value as AttemptRecord;
              if (matches(a, f) && seen++ >= keep) {
                c.delete();
                recordings.delete(a.id);
                removed++;
              }
              c.continue();
            };
          });
          return removed;
        }),
      );
    },
    async trimAttemptAudio(keepPerPhrase) {
      const keep = Number.isFinite(keepPerPhrase) ? Math.max(0, Math.floor(keepPerPhrase)) : 0;
      return run((db) =>
        transact(db, ['attemptAudio', 'attempts'], async (tx) => {
          const recordings = tx.objectStore('attemptAudio');
          const attempts = tx.objectStore('attempts');
          let removed = 0;
          await new Promise<void>((resolve, reject) => {
            let phrase: string | null = null;
            let seen = 0;
            const cur = recordings.index('byPhrase').openKeyCursor(null, 'prev'); // keys only: the recordings are not read
            cur.onerror = () => reject(cur.error);
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) return resolve();
              const [phraseId] = c.key as [string, number];
              if (phraseId !== phrase) {
                phrase = phraseId;
                seen = 0;
              }
              if (++seen > keep) {
                const id = c.primaryKey as string;
                recordings.delete(id);
                const get = attempts.get(id);
                get.onsuccess = () => {
                  const rec = get.result as AttemptRecord | undefined;
                  if (rec && rec.hasAudio) attempts.put({ ...rec, hasAudio: false });
                };
                removed++;
              }
              c.continue();
            };
          });
          return removed;
        }),
      );
    },
    async getMeta<T>(key: string) {
      return run(async (db) => {
        const row = (await req(db.transaction('meta').objectStore('meta').get(key))) as { value: T } | undefined;
        return row ? row.value : null;
      });
    },
    async setMeta(key, value) {
      requireId(key, 'A setting');
      return run((db) => transact(db, ['meta'], (tx) => void tx.objectStore('meta').put({ key, value })));
    },
    async usage() {
      return run(async (db) => {
        const tx = db.transaction(['clips', 'attempts', 'audio', 'attemptAudio']);
        const clips = await req(tx.objectStore('clips').count());
        const attempts = await req(tx.objectStore('attempts').count());
        let audioBytes = 0;
        for (const name of ['audio', 'attemptAudio'] as const) {
          await new Promise<void>((resolve, reject) => {
            const cur = tx.objectStore(name).index('byBytes').openKeyCursor(); // the key is the row's byte count
            cur.onerror = () => reject(cur.error);
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) return resolve();
              audioBytes += c.key as number;
              c.continue();
            };
          });
        }
        return { clips, attempts, audioBytes };
      });
    },
    async pruneOrphanAudio() {
      return run((db) =>
        transact(db, ['clips', 'audio'], async (tx) => {
          const audio = tx.objectStore('audio');
          const clips = tx.objectStore('clips');
          const ids: string[] = [];
          await new Promise<void>((resolve, reject) => {
            const cur = audio.index('byClip').openKeyCursor(); // keys only: the chunks are not read
            cur.onerror = () => reject(cur.error);
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) return resolve();
              const id = c.key as string;
              ids.push(id);
              c.continue(`${id}\u0000`); // the next clip id: skip this clip's other chunks
            };
          });
          let removed = 0;
          for (const id of ids) {
            if ((await req(clips.count(id))) > 0) continue;
            audio.delete(audioRange(id));
            removed++;
          }
          return removed;
        }),
      );
    },
    async clearAll() {
      return run((db) =>
        transact(db, [...STORE_NAMES], (tx) => {
          for (const n of STORE_NAMES) tx.objectStore(n).clear();
        }),
      );
    },
    close() {
      conn.close();
    },
  };

  // A browser can open a database and still refuse to store anything (private modes, full disks): find out now. The probe is
  // bounded too: a store that opens but never answers must not hold "Opening your library" up for ever.
  const probe = store
    .setMeta(PROBE_KEY, Date.now())
    .then(() => store.getMeta<number>(PROBE_KEY))
    .then((v) => {
      if (typeof v !== 'number') throw new StoreUnavailableError('IndexedDB opened but did not keep what was written.');
    })
    .then(() =>
      run((db) => transact(db, ['meta'], (tx) => void tx.objectStore('meta').delete(PROBE_KEY))),
    );
  return withOpenTimeout(probe, cfg.openTimeoutMs * 2)
    .then(() => store)
    .catch((err) => {
      conn.close();
      throw err instanceof StoreUnavailableError ? err : new StoreUnavailableError(err instanceof Error && err.message ? `IndexedDB cannot store clips here: ${err.message}` : 'IndexedDB cannot store clips here.');
    });
}

// ---------------------------------------------------------------------------------------------
// The in-memory store

export interface MemoryStoreOptions {
  /** Total bytes of clip audio plus attempt recordings the store accepts; a write beyond it rejects with QuotaError and changes nothing. */
  quotaBytes?: number;
}

interface MemoryRecording {
  phraseId: string;
  at: number;
  sampleRate: number;
  pcm: Int16Array;
}

export function createMemoryClipStore(options: MemoryStoreOptions = {}): ClipStore {
  const clips = new Map<string, ClipRecord>();
  const audio = new Map<string, { mix?: Int16Array[]; vocal?: Int16Array[] }>();
  const attempts = new Map<string, AttemptRecord>();
  const recordings = new Map<string, MemoryRecording>();
  const meta = new Map<string, unknown>();

  const sum = (chunks: Int16Array[] | undefined): number => (chunks ? chunks.reduce((n, c) => n + c.byteLength, 0) : 0);
  const bytesInUse = (): number => {
    let n = 0;
    for (const a of audio.values()) n += sum(a.mix) + sum(a.vocal);
    for (const r of recordings.values()) n += r.pcm.byteLength;
    return n;
  };
  const checkQuota = (adding: number, replacing: number): void => {
    if (options.quotaBytes !== undefined && bytesInUse() - replacing + adding > options.quotaBytes) {
      throw new QuotaError('The device has no room for this clip. Free some space or remove clips you no longer practise.', adding);
    }
  };

  return {
    kind: 'memory',
    async listClips() {
      return [...clips.values()].sort(byAddedDesc).map(plainClone);
    },
    async getClip(id) {
      const c = clips.get(id);
      return c ? plainClone(c) : null;
    },
    async putClip(c) {
      requireId(c?.id, 'A clip');
      clips.set(c.id, plainClone(c));
    },
    async deleteClip(id) {
      clips.delete(id);
      audio.delete(id);
      for (const [aid, a] of [...attempts]) {
        if (a.clipId === id) {
          attempts.delete(aid);
          recordings.delete(aid);
        }
      }
    },
    async writeAudio(clipId, kind, pcm, sampleRate): Promise<ClipAudioInfo> {
      requireId(clipId, 'Audio');
      requireKind(kind);
      const chunkFrames = chunkFramesFor(sampleRate);
      checkQuota(pcm.byteLength, sum(audio.get(clipId)?.[kind]));
      const chunks = chunkRanges(pcm.length, chunkFrames).map(([a, b]) => pcm.slice(a, b));
      audio.set(clipId, { ...audio.get(clipId), [kind]: chunks });
      return { kind, sampleRate, frames: pcm.length, chunkFrames };
    },
    async readAudio(clipId, info, fromSec, toSec) {
      checkInfo(info);
      const r = chunksFor(fromSec, toSec, info.sampleRate, info.chunkFrames, info.frames);
      if (r.to <= r.from) return new Float32Array(0);
      const chunks = audio.get(clipId)?.[info.kind];
      if (!chunks || chunks.length <= r.last) throw new AudioMissingError();
      return sliceChunks(chunks.slice(r.first, r.last + 1), r.first, info.chunkFrames, r.from, r.to);
    },
    async deleteAudio(clipId, kind) {
      requireKind(kind);
      const entry = audio.get(clipId);
      if (!entry) return;
      const rest = { ...entry };
      delete rest[kind];
      if (rest.mix || rest.vocal) audio.set(clipId, rest);
      else audio.delete(clipId);
    },
    async addAttempt(a, au) {
      checkAttempt(a);
      if (au) checkQuota(au.pcm.byteLength, recordings.get(a.id)?.pcm.byteLength ?? 0);
      attempts.set(a.id, plainClone({ ...a, hasAudio: au !== undefined }));
      if (au) recordings.set(a.id, { phraseId: a.phraseId, at: a.at, sampleRate: au.sampleRate, pcm: au.pcm.slice() });
      else recordings.delete(a.id);
    },
    async listAttempts(f) {
      return cap([...attempts.values()].filter((a) => matches(a, f)).sort(newestFirst), f.limit).map(plainClone);
    },
    async listRecentAttempts(perPhrase) {
      const n = Math.floor(perPhrase);
      if (!(n >= 1)) return [];
      const seen = new Map<string, number>();
      const out: AttemptRecord[] = [];
      for (const a of [...attempts.values()].sort(newestFirst)) {
        const k = seen.get(a.phraseId) ?? 0;
        if (k < n) out.push(plainClone(a));
        seen.set(a.phraseId, k + 1);
      }
      return out;
    },
    async readAttemptAudio(id) {
      const r = recordings.get(id);
      return r ? { pcm: r.pcm.slice(), sampleRate: r.sampleRate } : null;
    },
    async deleteAttempts(f) {
      const keep = f.keepLast !== undefined && Number.isFinite(f.keepLast) ? Math.max(0, Math.floor(f.keepLast)) : 0;
      const doomed = [...attempts.values()].filter((a) => matches(a, f)).sort(newestFirst).slice(keep);
      for (const a of doomed) {
        attempts.delete(a.id);
        recordings.delete(a.id);
      }
      return doomed.length;
    },
    async trimAttemptAudio(keepPerPhrase) {
      const keep = Number.isFinite(keepPerPhrase) ? Math.max(0, Math.floor(keepPerPhrase)) : 0;
      const byPhrase = new Map<string, { id: string; at: number }[]>();
      for (const [id, r] of recordings) byPhrase.set(r.phraseId, [...(byPhrase.get(r.phraseId) ?? []), { id, at: r.at }]);
      let removed = 0;
      for (const list of byPhrase.values()) {
        list.sort((x, y) => y.at - x.at || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
        for (const { id } of list.slice(keep)) {
          recordings.delete(id);
          const rec = attempts.get(id);
          if (rec) attempts.set(id, { ...rec, hasAudio: false });
          removed++;
        }
      }
      return removed;
    },
    async getMeta<T>(key: string) {
      return meta.has(key) ? plainClone(meta.get(key) as T) : null;
    },
    async setMeta(key, value) {
      requireId(key, 'A setting');
      meta.set(key, plainClone(value));
    },
    async usage() {
      return { clips: clips.size, attempts: attempts.size, audioBytes: bytesInUse() };
    },
    async pruneOrphanAudio() {
      let removed = 0;
      for (const id of [...audio.keys()]) {
        if (clips.has(id)) continue;
        audio.delete(id);
        removed++;
      }
      return removed;
    },
    async clearAll() {
      clips.clear();
      audio.clear();
      attempts.clear();
      recordings.clear();
      meta.clear();
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------------------------
// Opening with a fallback

export interface OpenedStore {
  store: ClipStore;
  /**
   * Set when IndexedDB could not be used and `store` is the in-memory one: clips are lost when the app closes. `retryable` says
   * that opening again later (a tap on "Try again", the app coming back to the foreground) can work: a timeout, a transient
   * browser error, another tab holding the database.
   */
  fallback: { reason: string; retryable: boolean } | null;
}

/** Opens IndexedDB, or falls back to a labelled memory-only store. Never rejects. */
export async function openClipStoreWithFallback(open: () => Promise<ClipStore> = () => openClipStore()): Promise<OpenedStore> {
  try {
    return { store: await open(), fallback: null };
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : 'IndexedDB could not be opened.';
    return { store: createMemoryClipStore(), fallback: { reason, retryable: err instanceof StoreUnavailableError && err.retryable } };
  }
}

/**
 * Copies a whole library (clips with their audio, attempts with their recordings, settings) from one store to another: what
 * a session kept in memory while IndexedDB was unavailable, once IndexedDB opens again. Ids already in `to` are left alone.
 */
export async function copyLibrary(from: ClipStore, to: ClipStore): Promise<{ clips: number; attempts: number }> {
  const known = new Set((await to.listClips()).map((c) => c.id));
  let clipCount = 0;
  for (const clip of await from.listClips()) {
    if (known.has(clip.id)) continue;
    // Audio first, record last: a copy that stops half way leaves chunks without a record (swept on the next open), never a record without audio.
    for (const info of [clip.audio.mix, clip.audio.vocal]) {
      if (!info || clip.audioMissing) continue;
      const pcm = new Int16Array(info.frames);
      let w = 0;
      const windowSec = CHUNK_SEC;
      for (let t = 0; t * info.sampleRate < info.frames; t += windowSec) {
        const part = floatToInt16(await from.readAudio(clip.id, info, t, t + windowSec));
        pcm.set(part, w);
        w += part.length;
      }
      await to.writeAudio(clip.id, info.kind, pcm, info.sampleRate);
    }
    await to.putClip(clip);
    clipCount++;
  }
  const knownAttempts = new Set((await to.listAttempts({})).map((a) => a.id));
  let attemptCount = 0;
  for (const attempt of await from.listAttempts({})) {
    if (knownAttempts.has(attempt.id)) continue;
    const recording = attempt.hasAudio ? await from.readAttemptAudio(attempt.id) : null;
    await to.addAttempt(attempt, recording ?? undefined);
    attemptCount++;
  }
  for (const key of [META.calibration, META.attemptsSinceExport, META.lastExportAt]) {
    const value = await from.getMeta<unknown>(key);
    if (value !== null && (await to.getMeta(key)) === null) await to.setMeta(key, value);
  }
  return { clips: clipCount, attempts: attemptCount };
}
